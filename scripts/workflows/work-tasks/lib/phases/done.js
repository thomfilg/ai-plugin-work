/**
 * Phase: done — terminal.
 */

'use strict';

const { TASKS_PHASES } = require('../../tasks-phase-registry');

function validate() {
  return { ok: false, errors: [] };
}

function instructions(ctx) {
  return [
    `# tasks-next — DONE`,
    `Ticket: ${ctx.ticket}`,
    '',
    'All tasks phases recorded. Artifacts produced:',
    `- \`tasks.md\` (numbered tasks with kinds, requirements, and traceability)`,
    `- \`tasks-phase.json\``,
    '',
    'Re-invoke /work2 (or /work) to advance to the tasks_gate step.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASKS_PHASES.done, { next: null, validate, instructions });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
