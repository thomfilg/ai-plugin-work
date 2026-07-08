/**
 * Phase: done — terminal.
 */

'use strict';

const { TASK_REVIEW_PHASES } = require('../../task-review-phase-registry');

function validate() {
  return { ok: true, summary: 'task-reviewer terminal phase' };
}

function instructions(ctx) {
  return [
    '# task-review-next — Phase 8 of 8: DONE',
    `Ticket: ${ctx.ticket}`,
    '',
    'Task review complete. Return the final task-review.check.md.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASK_REVIEW_PHASES.done, {
    next: null,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
