/**
 * Phase: done — terminal.
 */

'use strict';

const { PR_REVIEW_PHASES } = require('../../pr-review-phase-registry');

function validate() {
  return { ok: true, summary: 'pr-reviewer terminal phase' };
}

function instructions(ctx) {
  return [
    '# pr-review-next — Phase 8 of 8: DONE',
    `Ticket: ${ctx.ticket}`,
    '',
    'Review posted, memorized, complete. Return final pr-review.check.md.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(PR_REVIEW_PHASES.done, {
    next: null,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
