/**
 * Phase: memorize — persist the review verdict to the memory plugin.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PR_REVIEW_PHASES } = require('../../pr-review-phase-registry');

const SENTINEL = '.pr-review-memorized';

function validate(ctx) {
  if (!ctx.memory) return { ok: true, summary: 'no memory plugin detected — skipping' };
  const p = path.join(ctx.tasksDir, SENTINEL);
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      errors: [
        `Memory plugin "${ctx.memory.name}" available but \`${SENTINEL}\` missing. Call \`${ctx.memory.rememberTool}\` with the verdict + critical findings, then \`touch ${p}\`.`,
      ],
    };
  }
  return { ok: true, summary: `memorized via ${ctx.memory.name}` };
}

function instructions(ctx) {
  if (!ctx.memory) {
    return [
      '# pr-review-next — Phase 7 of 8: MEMORIZE',
      '',
      'No memory plugin — auto-advance.',
      '',
    ].join('\n');
  }
  return [
    '# pr-review-next — Phase 7 of 8: MEMORIZE',
    `Ticket: ${ctx.ticket}`,
    '',
    `Memory: **${ctx.memory.name}**`,
    '',
    `1. Call \`${ctx.memory.rememberTool}\` with: PR number, verdict, top critical/important findings.`,
    `2. \`touch ${path.join(ctx.tasksDir, SENTINEL)}\`.`,
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(PR_REVIEW_PHASES.memorize, {
    next: PR_REVIEW_PHASES.done,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.SENTINEL = SENTINEL;
