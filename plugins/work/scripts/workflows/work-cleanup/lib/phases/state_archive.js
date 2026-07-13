/**
 * Phase: state_archive — confirm `cleanup-summary.md` exists with the
 * final cleanup record (branch deleted? tmux killed? worktree pending?).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CLEANUP_PHASES } = require('../../cleanup-phase-registry');
const { completionGateBlock } = require('../completion-evidence');

const SUMMARY_FILE = 'cleanup-summary.md';
const REQUIRED_SECTIONS = [/^##\s+Branch\b/im, /^##\s+Tmux sessions\b/im, /^##\s+Worktree\b/im];
const STATUS_RE = /^Status:\s*(DONE|PARTIAL)\b/im;

function validate(ctx) {
  // GH-283: fail closed if persisted cleanup state resumed past completion_check
  // without completion evidence — archiving/teardown must not finalize on an
  // unproven-complete ticket.
  const gate = completionGateBlock(ctx.tasksDir, 'state_archive');
  if (gate) return gate;

  const p = path.join(ctx.tasksDir, SUMMARY_FILE);
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      errors: [
        `\`${SUMMARY_FILE}\` missing. Write the cleanup record with sections: Branch, Tmux sessions, Worktree + final Status: DONE|PARTIAL.`,
      ],
    };
  }
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return { ok: false, errors: [`could not read \`${SUMMARY_FILE}\`: ${e.message}`] };
  }
  const missing = [];
  const names = ['## Branch', '## Tmux sessions', '## Worktree'];
  REQUIRED_SECTIONS.forEach((re, i) => {
    if (!re.test(text)) missing.push(names[i]);
  });
  if (missing.length) {
    return {
      ok: false,
      errors: [`\`${SUMMARY_FILE}\` missing section(s): ${missing.join(', ')}.`],
    };
  }
  if (!STATUS_RE.test(text)) {
    return {
      ok: false,
      errors: [`\`${SUMMARY_FILE}\` missing final \`Status: DONE\` or \`Status: PARTIAL\`.`],
    };
  }
  return { ok: true, summary: 'cleanup-summary.md complete' };
}

function instructions(ctx) {
  return [
    '# cleanup-next — Phase 6 of 8: STATE ARCHIVE',
    `Ticket: ${ctx.ticket}`,
    '',
    'Write `cleanup-summary.md` with:',
    '  ## Branch       (what was deleted, locally + remote)',
    '  ## Tmux sessions (what was killed, or "none matched")',
    '  ## Worktree     (path + whether removed or left for user)',
    '  Status: DONE | Status: PARTIAL  (PARTIAL = worktree left for manual removal)',
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(CLEANUP_PHASES.state_archive, {
    next: CLEANUP_PHASES.memorize,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.SUMMARY_FILE = SUMMARY_FILE;
