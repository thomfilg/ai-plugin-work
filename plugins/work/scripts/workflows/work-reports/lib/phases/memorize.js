/**
 * Phase: memorize — persist the cross-step summary to the memory plugin.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { REPORTS_PHASES } = require('../../reports-phase-registry');

const SENTINEL = '.reports-memorized';

function validate(ctx) {
  if (!ctx.memory) return { ok: true, summary: 'no memory plugin detected — skipping' };
  const p = path.join(ctx.tasksDir, SENTINEL);
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      errors: [
        `Memory plugin "${ctx.memory.name}" available but \`${SENTINEL}\` missing. Call \`${ctx.memory.rememberTool}\` with the ticket summary + final status, then \`touch ${p}\`.`,
      ],
    };
  }
  return { ok: true, summary: `memorized via ${ctx.memory.name}` };
}

function instructions(ctx) {
  if (!ctx.memory) {
    return [
      '# reports-next — Phase 5 of 6: MEMORIZE',
      '',
      'No memory plugin — auto-advance.',
      '',
    ].join('\n');
  }
  return [
    '# reports-next — Phase 5 of 6: MEMORIZE',
    `Ticket: ${ctx.ticket}`,
    '',
    `Memory: **${ctx.memory.name}**`,
    '',
    `1. Call \`${ctx.memory.rememberTool}\` with: ticket id, final status, brief outcome summary.`,
    `2. \`touch ${path.join(ctx.tasksDir, SENTINEL)}\`.`,
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(REPORTS_PHASES.memorize, {
    next: REPORTS_PHASES.done,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.SENTINEL = SENTINEL;
