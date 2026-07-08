/**
 * Phase: inputs — confirm planning artifacts exist before running the
 * completion check. Failing here means the agent is being invoked without
 * the documents it needs to verify against.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { COMPLETION_PHASES } = require('../../completion-phase-registry');
const { resetStore } = require('../failure-store');

function validate(ctx) {
  // Start every completion-checker run with a clean failure store so prior
  // verdicts don't leak into the new one. Persistence is needed because the
  // phase-runner builds a fresh ctx per invocation (see failure-store.js).
  resetStore(ctx.tasksDir);
  const required = ['brief.md', 'spec.md', 'tasks.md'];
  const missing = required.filter((f) => !fs.existsSync(path.join(ctx.tasksDir, f)));
  if (missing.length === required.length) {
    return {
      ok: false,
      errors: [
        `No planning artifacts found in ${ctx.tasksDir}. completion-checker needs at least one of: ${required.join(', ')}.`,
      ],
    };
  }
  const warnings = missing.length
    ? [`Missing planning artifact(s): ${missing.join(', ')} — verification will be degraded.`]
    : [];
  return {
    ok: true,
    warnings,
    summary: `${required.length - missing.length}/${required.length} artifacts present`,
  };
}

function instructions(ctx) {
  return [
    '# completion-next — Phase 1 of 11: INPUTS',
    `Ticket: ${ctx.ticket}`,
    '',
    '### What I check',
    '- `brief.md`, `spec.md`, `tasks.md` exist in the tasks dir',
    '- Memory plugin available for recall (cortex/mem0)',
    '',
    `Memory plugin: ${ctx.memory ? ctx.memory.name : '(none detected)'}`,
    `Linked tickets: ${ctx.linkedIds.length}${ctx.linkedIds.length ? ` (${ctx.linkedIds.join(', ')})` : ''}`,
    '',
    '### What you do',
    'If a memory plugin is available, recall prior completion-check decisions for this ticket and sibling tickets. Then re-invoke me.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(COMPLETION_PHASES.inputs, {
    next: COMPLETION_PHASES.requirements_extract,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
