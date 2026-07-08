/**
 * Phase: done — terminal.
 */

'use strict';

const { QA_PHASES } = require('../../qa-phase-registry');

function validate() {
  return { ok: true, summary: 'qa-feature-tester terminal phase' };
}

function instructions(ctx) {
  return [
    '# qa-next — Phase 9 of 9: DONE',
    `Ticket: ${ctx.ticket}`,
    '',
    'All QA phases passed. Return your final qa-feature.check.md to the orchestrator.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(QA_PHASES.done, {
    next: null,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
