/**
 * Phase: done — terminal. No advance, no validation, just instructions.
 */

'use strict';

const { BRIEF_PHASES } = require('../../brief-phase-registry');

function validate() {
  // done is terminal — never advances.
  return { ok: false, errors: [] };
}

function instructions(ctx) {
  return [
    `# brief-next — DONE`,
    `Ticket: ${ctx.ticket}`,
    '',
    'All five phases recorded. Artifacts:',
    `- \`brief.md\``,
    `- \`sibling-overlap.md\``,
    `- \`_related/<id>.md\` (per linked ticket)`,
    `- \`brief-phase.json\``,
    '',
    'Re-invoke /work (or /work) to advance to the brief_gate step.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(BRIEF_PHASES.done, {
    next: null,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
