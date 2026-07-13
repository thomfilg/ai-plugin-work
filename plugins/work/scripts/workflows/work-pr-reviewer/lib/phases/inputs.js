/**
 * Phase: inputs — confirm planning artifacts available for the review.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PR_REVIEW_PHASES } = require('../../pr-review-phase-registry');

function validate(ctx) {
  const required = ['brief.md', 'spec.md', 'tasks.md'];
  const missing = required.filter((f) => !fs.existsSync(path.join(ctx.tasksDir, f)));
  const warnings = missing.length
    ? [`Missing planning artifact(s): ${missing.join(', ')} — review confidence degraded.`]
    : [];
  return {
    ok: true,
    warnings,
    summary: `${required.length - missing.length}/${required.length} artifacts present`,
  };
}

function instructions(ctx) {
  return [
    '# pr-review-next — Phase 1 of 8: INPUTS',
    `Ticket: ${ctx.ticket}`,
    '',
    'I check `brief.md`, `spec.md`, `tasks.md` exist. They are your review baseline.',
    '',
    `Memory plugin: ${ctx.memory ? ctx.memory.name : '(none detected)'}`,
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(PR_REVIEW_PHASES.inputs, {
    next: PR_REVIEW_PHASES.pr_context,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
