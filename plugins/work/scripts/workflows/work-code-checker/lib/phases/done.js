/**
 * Phase: done — terminal.
 */

'use strict';

const { CODE_PHASES } = require('../../code-phase-registry');

function validate() {
  return { ok: true, summary: 'code-checker terminal phase' };
}

function instructions(ctx) {
  return [
    '# code-next — Phase 8 of 8: DONE',
    `Ticket: ${ctx.ticket}`,
    '',
    'All code-review phases passed. Return the final report to the orchestrator.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(CODE_PHASES.done, {
    next: null,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
