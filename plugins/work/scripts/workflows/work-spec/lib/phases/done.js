/**
 * Phase: done — terminal.
 */

'use strict';

const { SPEC_PHASES } = require('../../spec-phase-registry');

function validate() {
  return { ok: false, errors: [] };
}

function instructions(ctx) {
  return [
    `# spec-next — DONE`,
    `Ticket: ${ctx.ticket}`,
    '',
    'All spec phases recorded. Artifacts produced:',
    `- \`spec.md\` (with \`## Verified sibling surface\` and \`## Kind verification\` sections)`,
    `- \`spec-phase.json\``,
    '',
    'Re-invoke /work (or /work) to advance to the spec_gate step.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(SPEC_PHASES.done, {
    next: null,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
