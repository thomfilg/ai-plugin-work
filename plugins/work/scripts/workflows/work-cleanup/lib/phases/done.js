/**
 * Phase: done — terminal.
 */

'use strict';

const { CLEANUP_PHASES } = require('../../cleanup-phase-registry');
const { completionGateBlock } = require('../completion-evidence');

function validate(ctx) {
  // GH-283: the terminal phase still fails closed if persisted cleanup state
  // resumed past completion_check without completion evidence — a rogue saved
  // state at `done` must not let cleanup finalize without **Status:** COMPLETE.
  const gate = completionGateBlock(ctx && ctx.tasksDir, 'done');
  if (gate) return gate;
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
