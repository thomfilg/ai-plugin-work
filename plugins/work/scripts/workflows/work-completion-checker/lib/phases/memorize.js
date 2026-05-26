/**
 * Phase: memorize — persist the completion verdict to the memory plugin
 * (cortex / mem0). Sentinel `.completion-memorized` is written next to
 * the report once the agent confirms it called the memory plugin.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { COMPLETION_PHASES } = require('../../completion-phase-registry');

const SENTINEL = '.completion-memorized';

function validate(ctx) {
  if (!ctx.memory) {
    return {
      ok: true,
      summary: 'no memory plugin detected — skipping memorize',
    };
  }
  const p = path.join(ctx.tasksDir, SENTINEL);
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      errors: [
        `Memory plugin "${ctx.memory.name}" is available but \`${SENTINEL}\` is missing. Call \`${ctx.memory.remember}\` with the completion verdict, then \`touch ${p}\`.`,
      ],
    };
  }
  return { ok: true, summary: `memorized via ${ctx.memory.name}` };
}

function instructions(ctx) {
  if (!ctx.memory) {
    return [
      '# completion-next — Phase 7 of 8: MEMORIZE',
      `Ticket: ${ctx.ticket}`,
      '',
      'No memory plugin detected — skipping. I will auto-advance.',
      '',
    ].join('\n');
  }
  return [
    '# completion-next — Phase 7 of 8: MEMORIZE',
    `Ticket: ${ctx.ticket}`,
    '',
    `Memory plugin: **${ctx.memory.name}**`,
    '',
    '### What you do',
    `1. Call \`${ctx.memory.remember}\` with a concise note: ticket id, final status (COMPLETE/INCOMPLETE), key file citations, any sibling-scope gate hits.`,
    `2. \`touch ${path.join(ctx.tasksDir, SENTINEL)}\` so this phase can advance.`,
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(COMPLETION_PHASES.memorize, {
    next: COMPLETION_PHASES.done,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.SENTINEL = SENTINEL;
