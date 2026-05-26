/**
 * Phase: memorize — persist QA verdict to memory plugin.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { QA_PHASES } = require('../../qa-phase-registry');

const SENTINEL = '.qa-memorized';

function validate(ctx) {
  if (!ctx.memory) return { ok: true, summary: 'no memory plugin detected — skipping' };
  const p = path.join(ctx.tasksDir, SENTINEL);
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      errors: [
        `Memory plugin "${ctx.memory.name}" available but \`${SENTINEL}\` is missing. Call \`${ctx.memory.rememberTool}\` with the QA verdict, then \`touch ${p}\`.`,
      ],
    };
  }
  return { ok: true, summary: `memorized via ${ctx.memory.name}` };
}

function instructions(ctx) {
  if (!ctx.memory) {
    return ['# qa-next — Phase 8 of 9: MEMORIZE', '', 'No memory plugin — auto-advance.', ''].join(
      '\n'
    );
  }
  return [
    '# qa-next — Phase 8 of 9: MEMORIZE',
    `Ticket: ${ctx.ticket}`,
    '',
    `Memory: **${ctx.memory.name}**`,
    '',
    `1. Call \`${ctx.memory.rememberTool}\` with: ticket id, APPROVED/BLOCKED, key kind verdicts, any flaky scenarios.`,
    `2. \`touch ${path.join(ctx.tasksDir, SENTINEL)}\`.`,
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(QA_PHASES.memorize, {
    next: QA_PHASES.done,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.SENTINEL = SENTINEL;
