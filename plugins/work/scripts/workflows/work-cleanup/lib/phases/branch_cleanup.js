/**
 * Phase: branch_cleanup — instruction-only.
 *
 * The agent runs the destructive git commands manually (we don't want
 * cleanup-next.js to silently delete branches). This phase verifies the
 * agent has produced a `.branch-cleaned` sentinel after running the
 * documented commands.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CLEANUP_PHASES } = require('../../cleanup-phase-registry');
const { completionGateBlock } = require('../completion-evidence');

const SENTINEL = '.branch-cleaned';

function readContext(tasksDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(tasksDir, 'cleanup-context.json'), 'utf8'));
  } catch {
    return null;
  }
}

function validate(ctx) {
  // Fail CLOSED before the destructive-command sentinel check: a ticket whose
  // persisted cleanup state resumes at (or past) branch_cleanup — e.g. state
  // saved by the old flow that had no completion_check phase — must NOT reach
  // the branch-delete instructions without completion evidence. In the normal
  // forward flow completion_check already passed immediately before this phase,
  // so this guard is a no-op; it only bites a resumed old-state ticket or a
  // tampered/clobbered report. Shared with the other post-gate destructive
  // phases via completionGateBlock (GH-283).
  const gate = completionGateBlock(ctx.tasksDir, 'branch_cleanup');
  if (gate) return gate;

  const p = path.join(ctx.tasksDir, SENTINEL);
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      errors: [
        `\`${SENTINEL}\` missing. Run the branch-cleanup commands shown in instructions, then \`touch ${p}\`.`,
      ],
    };
  }
  return { ok: true, summary: 'branch cleaned' };
}

function instructions(ctx) {
  const c = readContext(ctx.tasksDir);
  const branch = c && c.branch ? c.branch : '<your-branch>';
  return [
    '# cleanup-next — Phase 4 of 8: BRANCH CLEANUP',
    `Ticket: ${ctx.ticket}`,
    '',
    'Completion gate: this phase fails closed unless completion.check.md reads ' +
      '**Status:** COMPLETE. If it blocks, re-run the check step (or restore the ' +
      'archived report) before retrying — the destructive commands below are ' +
      'withheld until completion evidence is present.',
    '',
    'Run the following from the worktree root, then `touch` the sentinel:',
    '',
    '```bash',
    'git fetch origin --prune',
    `git switch main && git pull origin main`,
    `git branch -d ${branch}  # use -D only if -d reports unmerged work AND you've confirmed PR is merged`,
    `git push origin --delete ${branch}  # skip if branch auto-deleted by merge`,
    `touch ${path.join(ctx.tasksDir, SENTINEL)}`,
    '```',
    '',
    'Re-run me after the sentinel exists.',
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(CLEANUP_PHASES.branch_cleanup, {
    next: CLEANUP_PHASES.tmux_cleanup,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.SENTINEL = SENTINEL;
