/**
 * Phase: memorize — persist key decisions to an installed memory plugin.
 *
 * Three transition modes:
 *   - No memory plugin → auto-advance with summary `no-memory-plugin`.
 *   - Memory plugin + `.brief-memorized` sentinel present → advance with
 *     summary `via=<plugin name>`.
 *   - Memory plugin + no sentinel → WAIT (not blocked, just no-advance).
 *     This is signalled by `validate` returning `ok: false, errors: []`.
 *
 * The sentinel pattern lets the agent declare "I've persisted my decisions"
 * via a single file touch — we can't introspect plugin tools to verify
 * remember calls actually happened.
 */

'use strict';

const { validateMemorizePhase, memorizeInstructions } = require('../../../lib/memory-record');

/** This phase's slice of the ticket's memory record. */
const SCOPE = 'brief';

const { BRIEF_PHASES } = require('../../brief-phase-registry');

function validate(ctx) {
  return validateMemorizePhase({ scope: SCOPE, ctx, wait: true });
}

function instructions(ctx) {
  return memorizeInstructions({
    title: '# brief-next — Phase 5 of 5: MEMORIZE',
    scope: SCOPE,
    ctx,
    what: [
      'The key decisions in the brief and the constraints they came from.',
      'Any linked or related ticket ids discovered while writing it.',
      'What a sibling ticket touching this area should know before starting.',
    ],
  });
}

module.exports = function register(registerPhase) {
  registerPhase(BRIEF_PHASES.memorize, {
    next: BRIEF_PHASES.done,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
