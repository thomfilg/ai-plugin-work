/**
 * Phase: memorize — persist cleanup record to the memory plugin.
 */

'use strict';

const { validateMemorizePhase, memorizeInstructions } = require('../../../lib/memory-record');

/** This phase's slice of the ticket's memory record. */
const SCOPE = 'cleanup';

const { CLEANUP_PHASES } = require('../../cleanup-phase-registry');

function validate(ctx) {
  return validateMemorizePhase({ scope: SCOPE, ctx });
}

function instructions(ctx) {
  return memorizeInstructions({
    title: '# cleanup-next — Phase 6 of 7: MEMORIZE',
    scope: SCOPE,
    ctx,
    what: [
      'Ticket id and final cleanup status.',
      'Branch deleted and tmux sessions killed.',
      'Anything deferred, such as a worktree left for manual removal.',
    ],
  });
}

module.exports = function register(r) {
  r(CLEANUP_PHASES.memorize, {
    next: CLEANUP_PHASES.done,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
