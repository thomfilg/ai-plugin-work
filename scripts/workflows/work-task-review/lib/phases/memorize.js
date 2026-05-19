/**
 * Phase: memorize — persist task-review verdict to the memory plugin.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { TASK_REVIEW_PHASES } = require('../../task-review-phase-registry');

const SENTINEL = '.task-review-memorized';

function validate(ctx) {
  if (!ctx.memory) return { ok: true, summary: 'no memory plugin detected — skipping' };
  const p = path.join(ctx.tasksDir, SENTINEL);
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      errors: [
        `Memory plugin "${ctx.memory.name}" available but \`${SENTINEL}\` missing. Call \`${ctx.memory.rememberTool}\` with the task-review verdict, then \`touch ${p}\`.`,
      ],
    };
  }
  return { ok: true, summary: `memorized via ${ctx.memory.name}` };
}

function instructions(ctx) {
  if (!ctx.memory) {
    return [
      '# task-review-next — Phase 7 of 8: MEMORIZE',
      '',
      'No memory plugin — auto-advance.',
      '',
    ].join('\n');
  }
  return [
    '# task-review-next — Phase 7 of 8: MEMORIZE',
    `Ticket: ${ctx.ticket}`,
    '',
    `Memory: **${ctx.memory.name}**`,
    '',
    `1. Call \`${ctx.memory.rememberTool}\` with: ticket id, task index, APPROVED/BLOCKED, key kind findings.`,
    `2. \`touch ${path.join(ctx.tasksDir, SENTINEL)}\`.`,
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASK_REVIEW_PHASES.memorize, {
    next: TASK_REVIEW_PHASES.done,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.SENTINEL = SENTINEL;
