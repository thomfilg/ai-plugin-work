/**
 * Phase: inputs — confirm planning artifacts + last-commit-sha exist.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { TASK_REVIEW_PHASES } = require('../../task-review-phase-registry');

function validate(ctx) {
  const required = ['brief.md', 'spec.md', 'tasks.md'];
  const missing = required.filter((f) => !fs.existsSync(path.join(ctx.tasksDir, f)));
  const warnings = missing.length
    ? [`Missing planning artifact(s): ${missing.join(', ')} — review confidence degraded.`]
    : [];
  const shaFile = path.join(ctx.tasksDir, '.last-commit-sha');
  if (!fs.existsSync(shaFile)) {
    warnings.push(
      'No `.last-commit-sha` recorded — diff will fall back to base branch (broader scope).'
    );
  }
  return {
    ok: true,
    warnings,
    summary: `${required.length - missing.length}/${required.length} planning artifacts present`,
  };
}

function instructions(ctx) {
  return [
    '# task-review-next — Phase 1 of 8: INPUTS',
    `Ticket: ${ctx.ticket}`,
    '',
    'I check `brief.md`, `spec.md`, `tasks.md` and `.last-commit-sha` exist.',
    'task_review only reviews YOUR most-recent task — not the whole branch.',
    '',
    `Memory plugin: ${ctx.memory ? ctx.memory.name : '(none detected)'}`,
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASK_REVIEW_PHASES.inputs, {
    next: TASK_REVIEW_PHASES.diff_audit,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
