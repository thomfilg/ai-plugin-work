/**
 * Phase: inputs — confirm planning artifacts exist before launching QA.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { QA_PHASES } = require('../../qa-phase-registry');

function validate(ctx) {
  const required = ['brief.md', 'spec.md', 'tasks.md'];
  const missing = required.filter((f) => !fs.existsSync(path.join(ctx.tasksDir, f)));
  if (missing.length === required.length) {
    return {
      ok: false,
      errors: [
        `No planning artifacts found in ${ctx.tasksDir}. qa-feature-tester needs at least one of: ${required.join(', ')}.`,
      ],
    };
  }
  return {
    ok: true,
    summary: `${required.length - missing.length}/${required.length} artifacts present`,
  };
}

function instructions(ctx) {
  return [
    '# qa-next — Phase 1 of 9: INPUTS',
    `Ticket: ${ctx.ticket}`,
    '',
    'I verify `brief.md`, `spec.md`, `tasks.md` exist. These tell you what to test.',
    '',
    `Memory plugin: ${ctx.memory ? ctx.memory.name : '(none detected)'}`,
    '',
    'If a memory plugin is available, recall prior QA failures for this ticket / sibling tickets before testing.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(QA_PHASES.inputs, {
    next: QA_PHASES.env_setup,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
