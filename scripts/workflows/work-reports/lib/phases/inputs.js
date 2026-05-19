/**
 * Phase: inputs — confirm prior-step approval artifacts exist before
 * attempting to summarize them.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { REPORTS_PHASES } = require('../../reports-phase-registry');

const REQUIRED = ['tests.check.md', 'code-review.check.md', 'completion.check.md'];

function validate(ctx) {
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(ctx.tasksDir, f)));
  if (missing.length) {
    return {
      ok: false,
      errors: [
        `Cannot start reports: prior-step artifact(s) missing: ${missing.join(', ')}. Complete /check first.`,
      ],
    };
  }
  return { ok: true, summary: `${REQUIRED.length} prior-step artifact(s) present` };
}

function instructions(ctx) {
  return [
    '# reports-next — Phase 1 of 6: INPUTS',
    `Ticket: ${ctx.ticket}`,
    '',
    `Required artifacts: ${REQUIRED.map((f) => `\`${f}\``).join(', ')}.`,
    '',
    `Memory plugin: ${ctx.memory ? ctx.memory.name : '(none detected)'}`,
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(REPORTS_PHASES.inputs, {
    next: REPORTS_PHASES.collect_artifacts,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.REQUIRED = REQUIRED;
