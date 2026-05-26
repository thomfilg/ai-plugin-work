/**
 * Phase: done — terminal. Nothing more to do.
 */

'use strict';

const { COMPLETION_PHASES } = require('../../completion-phase-registry');

function validate() {
  return { ok: true, summary: 'completion-checker terminal phase' };
}

function instructions(ctx) {
  return [
    '# completion-next — Phase 8 of 8: DONE',
    `Ticket: ${ctx.ticket}`,
    '',
    'All completion-check phases passed. Return your final report to the orchestrator.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(COMPLETION_PHASES.done, {
    next: null,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
