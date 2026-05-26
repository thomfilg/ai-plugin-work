/**
 * Phase: inputs — confirm planning artifacts exist before running quality
 * audit. Missing all of them → code-only review with degraded confidence.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CODE_PHASES } = require('../../code-phase-registry');

function validate(ctx) {
  const required = ['brief.md', 'spec.md', 'tasks.md'];
  const missing = required.filter((f) => !fs.existsSync(path.join(ctx.tasksDir, f)));
  const warnings = missing.length
    ? [
        `Missing planning artifact(s): ${missing.join(', ')} — review will fall back to code-only; lower the Confidence in the final report.`,
      ]
    : [];
  return {
    ok: true,
    warnings,
    summary: `${required.length - missing.length}/${required.length} artifacts present`,
  };
}

function instructions(ctx) {
  return [
    '# code-next — Phase 1 of 8: INPUTS',
    `Ticket: ${ctx.ticket}`,
    '',
    'I check whether `brief.md`, `spec.md`, `tasks.md` exist (these are required review inputs per agents/code-checker.md). Missing files do not block but should lower Confidence.',
    '',
    `Memory plugin: ${ctx.memory ? ctx.memory.name : '(none detected)'}`,
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(CODE_PHASES.inputs, {
    next: CODE_PHASES.change_classify,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
