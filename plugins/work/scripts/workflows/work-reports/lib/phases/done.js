/**
 * Phase: done — terminal.
 */

'use strict';

const { REPORTS_PHASES } = require('../../reports-phase-registry');

function validate() {
  return { ok: true, summary: 'reports terminal phase' };
}

function instructions(ctx) {
  return [
    '# reports-next — Phase 6 of 6: DONE',
    `Ticket: ${ctx.ticket}`,
    '',
    'Cross-step summary complete. Return the final reports.md.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(REPORTS_PHASES.done, {
    next: null,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
