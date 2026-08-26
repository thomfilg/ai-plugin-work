/**
 * Phase: memorize — persist QA verdict to memory plugin.
 */

'use strict';

const { validateMemorizePhase, memorizeInstructions } = require('../../../lib/memory-record');

/** This phase's slice of the ticket's memory record. */
const SCOPE = 'qa';

const { QA_PHASES } = require('../../qa-phase-registry');

function validate(ctx) {
  return validateMemorizePhase({ scope: SCOPE, ctx });
}

function instructions(ctx) {
  return memorizeInstructions({
    title: '# qa-next — Phase 8 of 9: MEMORIZE',
    scope: SCOPE,
    ctx,
    what: [
      'Scenarios exercised and the ones deliberately skipped.',
      'Defects found, and any environment quirk that made testing harder.',
    ],
  });
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
