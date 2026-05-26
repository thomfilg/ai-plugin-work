/**
 * Phase: memorize — persist cleanup record to the memory plugin.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CLEANUP_PHASES } = require('../../cleanup-phase-registry');

const SENTINEL = '.cleanup-memorized';

function validate(ctx) {
  if (!ctx.memory) return { ok: true, summary: 'no memory plugin detected — skipping' };
  const p = path.join(ctx.tasksDir, SENTINEL);
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      errors: [
        `Memory plugin "${ctx.memory.name}" available but \`${SENTINEL}\` missing. Call \`${ctx.memory.rememberTool}\` with: ticket id, branch deleted, sessions killed, final status. Then \`touch ${p}\`.`,
      ],
    };
  }
  return { ok: true, summary: `memorized via ${ctx.memory.name}` };
}

function instructions(ctx) {
  if (!ctx.memory) {
    return [
      '# cleanup-next — Phase 6 of 7: MEMORIZE',
      '',
      'No memory plugin — auto-advance.',
      '',
    ].join('\n');
  }
  return [
    '# cleanup-next — Phase 6 of 7: MEMORIZE',
    `Ticket: ${ctx.ticket}`,
    '',
    `Memory: **${ctx.memory.name}**`,
    '',
    `1. Call \`${ctx.memory.rememberTool}\` with: ticket id, cleanup status, any items deferred (e.g. worktree left for manual removal).`,
    `2. \`touch ${path.join(ctx.tasksDir, SENTINEL)}\`.`,
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(CLEANUP_PHASES.memorize, {
    next: CLEANUP_PHASES.done,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.SENTINEL = SENTINEL;
