/**
 * Phase: memorize — persist the code-review verdict to the memory plugin.
 * Sentinel `.code-review-memorized` is written once the agent confirms.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CODE_PHASES } = require('../../code-phase-registry');

const SENTINEL = '.code-review-memorized';

function validate(ctx) {
  if (!ctx.memory) return { ok: true, summary: 'no memory plugin detected — skipping' };
  const p = path.join(ctx.tasksDir, SENTINEL);
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      errors: [
        `Memory plugin "${ctx.memory.name}" is available but \`${SENTINEL}\` is missing. Call \`${ctx.memory.remember}\` with the review verdict, then \`touch ${p}\`.`,
      ],
    };
  }
  return { ok: true, summary: `memorized via ${ctx.memory.name}` };
}

function instructions(ctx) {
  if (!ctx.memory) {
    return [
      '# code-next — Phase 7 of 8: MEMORIZE',
      `Ticket: ${ctx.ticket}`,
      '',
      'No memory plugin detected — skipping. I will auto-advance.',
      '',
    ].join('\n');
  }
  return [
    '# code-next — Phase 7 of 8: MEMORIZE',
    `Ticket: ${ctx.ticket}`,
    '',
    `Memory plugin: **${ctx.memory.name}**`,
    '',
    `1. Call \`${ctx.memory.remember}\` with: ticket id, overall verdict (✅/⚠️/🔧/❌), critical findings (file:line), reuse decisions.`,
    `2. \`touch ${path.join(ctx.tasksDir, SENTINEL)}\`.`,
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(CODE_PHASES.memorize, {
    next: CODE_PHASES.done,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.SENTINEL = SENTINEL;
