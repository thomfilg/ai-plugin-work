/**
 * Phase: memorize — persist the cross-step summary to the memory plugin.
 */

'use strict';

const { validateMemorizePhase, memorizeInstructions } = require('../../../lib/memory-record');

/** This phase's slice of the ticket's memory record. */
const SCOPE = 'reports';

const { REPORTS_PHASES } = require('../../reports-phase-registry');

function validate(ctx) {
  return validateMemorizePhase({ scope: SCOPE, ctx });
}

function instructions(ctx) {
  return memorizeInstructions({
    title: '# reports-next — Phase 5 of 6: MEMORIZE',
    scope: SCOPE,
    ctx,
    what: [
      'The learnings recorded in `learnings.md`, in your own words.',
      'Cost or duration surprises worth expecting next time.',
    ],
  });
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
