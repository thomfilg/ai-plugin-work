'use strict';

const { PR_PHASES } = require('../../pr-phase-registry');

function validate() {
  return { ok: false, errors: [] };
}
function instructions(ctx) {
  return [
    `# pr-next — DONE`,
    `Ticket: ${ctx.ticket}`,
    '',
    'PR phases complete. The pull request was created/updated, validated, and any attachments wired.',
    'Re-invoke /work2 (or /work) to advance to the ready step.',
    '',
  ].join('\n');
}
module.exports = function register(r) {
  r(PR_PHASES.done, { next: null, validate, instructions });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
