/**
 * Phase: memorize — persist key spec decisions to the memory plugin.
 *
 * If a memory plugin is detected, the agent must save the verified surface
 * + key architecture decisions so future tickets can recall them. We gate
 * on a sentinel line `<!-- spec-memorized -->` in spec.md as a cheap
 * acknowledgement that the save happened.
 */

'use strict';

const { validateMemorizePhase, memorizeInstructions } = require('../../../lib/memory-record');

/** This phase's slice of the ticket's memory record. */
const SCOPE = 'spec';

const { SPEC_PHASES } = require('../../spec-phase-registry');

function validate(ctx) {
  return validateMemorizePhase({ scope: SCOPE, ctx });
}

function instructions(ctx) {
  return memorizeInstructions({
    title: '# spec-next — Phase 6 of 8: MEMORIZE',
    scope: SCOPE,
    ctx,
    what: [
      'The `## Verified sibling surface` block from spec.md (file::identifier pairs).',
      'Each `## Architecture Decisions` bullet, so future siblings know why this ticket made the trade-offs it did.',
      'The Reuse Audit hits and its explicit misses.',
    ],
  });
}

module.exports = function register(registerPhase) {
  registerPhase(SPEC_PHASES.memorize, {
    next: SPEC_PHASES.kind_checks,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
