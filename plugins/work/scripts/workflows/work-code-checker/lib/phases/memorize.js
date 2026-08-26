/**
 * Phase: memorize — persist the code-review verdict to the memory plugin.
 * Sentinel `.code-review-memorized` is written once the agent confirms.
 */

'use strict';

const { validateMemorizePhase, memorizeInstructions } = require('../../../lib/memory-record');

/** This phase's slice of the ticket's memory record. */
const SCOPE = 'code_review';

const { CODE_PHASES } = require('../../code-phase-registry');

function validate(ctx) {
  return validateMemorizePhase({ scope: SCOPE, ctx });
}

function instructions(ctx) {
  return memorizeInstructions({
    title: '# code-next — Phase 7 of 8: MEMORIZE',
    scope: SCOPE,
    ctx,
    what: [
      'Review findings that generalise beyond this ticket.',
      'Patterns worth repeating, and the ones worth refusing next time.',
    ],
  });
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
