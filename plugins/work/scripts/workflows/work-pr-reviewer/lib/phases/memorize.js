/**
 * Phase: memorize — persist the review verdict to the memory plugin.
 */

'use strict';

const { validateMemorizePhase, memorizeInstructions } = require('../../../lib/memory-record');

/** This phase's slice of the ticket's memory record. */
const SCOPE = 'pr_review';

const { PR_REVIEW_PHASES } = require('../../pr-review-phase-registry');

function validate(ctx) {
  return validateMemorizePhase({ scope: SCOPE, ctx });
}

function instructions(ctx) {
  return memorizeInstructions({
    title: '# pr-review-next — Phase 7 of 8: MEMORIZE',
    scope: SCOPE,
    ctx,
    what: [
      'Review themes that recurred across the diff.',
      'What a reviewer of the next PR in this area should look for first.',
    ],
  });
}

module.exports = function register(registerPhase) {
  registerPhase(PR_REVIEW_PHASES.memorize, {
    next: PR_REVIEW_PHASES.done,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
