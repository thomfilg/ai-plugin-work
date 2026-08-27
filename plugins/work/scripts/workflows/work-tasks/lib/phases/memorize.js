/**
 * Phase: memorize — persist the task plan summary to memory plugin.
 *
 * Sentinel-gated like brief/spec: agent appends `<!-- tasks-memorized -->`
 * to tasks.md after the memory save call(s) succeed.
 */

'use strict';

const { validateMemorizePhase, memorizeInstructions } = require('../../../lib/memory-record');

/** This phase's slice of the ticket's memory record. */
const SCOPE = 'tasks';

const { TASKS_PHASES } = require('../../tasks-phase-registry');

function validate(ctx) {
  return validateMemorizePhase({ scope: SCOPE, ctx });
}

function instructions(ctx) {
  return memorizeInstructions({
    title: '# tasks-next — Phase 7 of 7: MEMORIZE',
    scope: SCOPE,
    ctx,
    what: [
      'How the work was split, and the sequencing constraints behind it.',
      'Test Strategy choices per task, especially the citation kinds.',
    ],
  });
}

module.exports = function register(registerPhase) {
  registerPhase(TASKS_PHASES.memorize, {
    next: TASKS_PHASES.done,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
