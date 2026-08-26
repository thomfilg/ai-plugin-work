/**
 * Phase: memorize — persist the completion verdict to the memory plugin
 * (cortex / mem0). Sentinel `.completion-memorized` is written next to
 * the report once the agent confirms it called the memory plugin.
 */

'use strict';

const { validateMemorizePhase, memorizeInstructions } = require('../../../lib/memory-record');

/** This phase's slice of the ticket's memory record. */
const SCOPE = 'completion';

const { COMPLETION_PHASES } = require('../../completion-phase-registry');

function validate(ctx) {
  return validateMemorizePhase({ scope: SCOPE, ctx });
}

function instructions(ctx) {
  return memorizeInstructions({
    title: '# completion-next — Phase 10 of 11: MEMORIZE',
    scope: SCOPE,
    ctx,
    what: [
      'What the completion check verified, and what it could not.',
      'Gaps accepted deliberately, with the reason they were accepted.',
    ],
  });
}

module.exports = function register(registerPhase) {
  registerPhase(COMPLETION_PHASES.memorize, {
    next: COMPLETION_PHASES.done,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
