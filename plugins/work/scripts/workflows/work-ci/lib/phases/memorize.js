/**
 * Phase: memorize — persist CI patterns (known flakes, recurring
 * pre-existing failures) to memory plugin. Sentinel: ci-triage.json
 * contains `"memorized": true`.
 */

'use strict';

const { validateMemorizePhase, memorizeInstructions } = require('../../../lib/memory-record');

/** This phase's slice of the ticket's memory record. */
const SCOPE = 'ci';

const { CI_PHASES } = require('../../ci-phase-registry');

function validate(ctx) {
  return validateMemorizePhase({ scope: SCOPE, ctx });
}

function instructions(ctx) {
  return memorizeInstructions({
    title: '# ci-next — Phase 7 of 8: MEMORIZE',
    scope: SCOPE,
    ctx,
    what: [
      'Failure classifications from `ci-triage.json`, especially known flakes.',
      'Pre-existing failures that this ticket is not responsible for.',
      'Any job that needed a re-run, and why it was judged a flake.',
    ],
  });
}

module.exports = function register(r) {
  r(CI_PHASES.memorize, {
    next: CI_PHASES.done,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
