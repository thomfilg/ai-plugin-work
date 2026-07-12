/**
 * Phase: done — terminal.
 */

'use strict';

const { CLEANUP_PHASES } = require('../../cleanup-phase-registry');

function validate() {
  return { ok: true, summary: 'cleanup terminal phase' };
}

function instructions(ctx) {
  return [
    '# cleanup-next — Phase 8 of 8: DONE',
    `Ticket: ${ctx.ticket}`,
    '',
    'Cleanup complete. Workflow can advance to reports.',
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(CLEANUP_PHASES.done, {
    next: null,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
