/**
 * Phase: tmux_cleanup — list tmux sessions whose name CONTAINS the ticket id
 * and instruct the agent to kill only those. Strict scoping — never touches
 * sessions for other tickets.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { CLEANUP_PHASES } = require('../../cleanup-phase-registry');

const SENTINEL = '.tmux-cleaned';

function listSessionsMatching(ticketId) {
  const r = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return [];
  const safe = String(ticketId).replace(/[^A-Za-z0-9_-]/g, '');
  if (!safe) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && s.includes(safe));
}

function validate(ctx) {
  const p = path.join(ctx.tasksDir, SENTINEL);
  // Indirect via module.exports so tests can monkey-patch listSessionsMatching.
  const sessions = module.exports.listSessionsMatching(ctx.ticket);
  if (sessions.length === 0) {
    // Nothing to clean — auto-pass.
    try {
      fs.writeFileSync(p, `auto-passed at ${new Date().toISOString()}: no matching sessions\n`);
    } catch {
      /* hook-gated */
    }
    return { ok: true, summary: 'no matching tmux sessions' };
  }
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      errors: [
        `${sessions.length} tmux session(s) match ticket ${ctx.ticket}: ${sessions.map((s) => `\`${s}\``).join(', ')}. Kill ONLY these and \`touch ${p}\`. Do NOT kill sessions for other tickets.`,
      ],
    };
  }
  return { ok: true, summary: `${sessions.length} session(s) cleaned (sentinel present)` };
}

function instructions(ctx) {
  const sessions = listSessionsMatching(ctx.ticket);
  const killCmds = sessions.map((s) => `tmux kill-session -t ${JSON.stringify(s)}`).join('\n');
  return [
    '# cleanup-next — Phase 4 of 7: TMUX CLEANUP',
    `Ticket: ${ctx.ticket}`,
    '',
    sessions.length
      ? `Tmux sessions matching this ticket:\n  ${sessions.join('\n  ')}\n\nKill ONLY these (do NOT use tmux kill-server):`
      : 'No tmux sessions matched this ticket — auto-pass.',
    '',
    sessions.length ? '```bash' : '',
    sessions.length ? killCmds : '',
    sessions.length ? `touch ${path.join(ctx.tasksDir, SENTINEL)}` : '',
    sessions.length ? '```' : '',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

module.exports = function register(r) {
  r(CLEANUP_PHASES.tmux_cleanup, {
    next: CLEANUP_PHASES.state_archive,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.listSessionsMatching = listSessionsMatching;
module.exports.SENTINEL = SENTINEL;
