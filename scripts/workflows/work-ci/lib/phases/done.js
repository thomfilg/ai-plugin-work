'use strict';

const { CI_PHASES } = require('../../ci-phase-registry');

function validate() {
  return { ok: false, errors: [] };
}
function instructions(ctx) {
  return [
    `# ci-next — DONE`,
    `Ticket: ${ctx.ticket}`,
    '',
    'CI phases complete. All checks pass (or pre-existing failures are documented).',
    'Re-invoke /work2 (or /work) to advance to the cleanup step.',
    '',
  ].join('\n');
}
module.exports = function register(r) {
  r(CI_PHASES.done, { next: null, validate, instructions });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
