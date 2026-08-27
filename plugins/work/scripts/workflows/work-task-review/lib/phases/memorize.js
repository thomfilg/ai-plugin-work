/**
 * Phase: memorize — persist task-review verdict to the memory plugin.
 */

'use strict';

const { validateMemorizePhase, memorizeInstructions } = require('../../../lib/memory-record');

/** This phase's slice of the ticket's memory record. */
const SCOPE = 'task_review';

const { TASK_REVIEW_PHASES } = require('../../task-review-phase-registry');

function validate(ctx) {
  return validateMemorizePhase({ scope: SCOPE, ctx });
}

function instructions(ctx) {
  return memorizeInstructions({
    title: '# task-review-next — Phase 7 of 8: MEMORIZE',
    scope: SCOPE,
    ctx,
    what: [
      'Per-task review outcomes and any task that needed rework.',
      'Splitting mistakes worth avoiding when planning the next ticket.',
    ],
  });
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
