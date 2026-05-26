/**
 * Phase: memorize — persist the task plan summary to memory plugin.
 *
 * Sentinel-gated like brief/spec: agent appends `<!-- tasks-memorized -->`
 * to tasks.md after the memory save call(s) succeed.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { TASKS_PHASES } = require('../../tasks-phase-registry');

const SENTINEL = '<!-- tasks-memorized -->';

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function validate(ctx) {
  if (!ctx.memory) {
    return { ok: true, summary: 'no memory plugin detected — auto-passing memorize' };
  }
  const text = readFile(path.join(ctx.tasksDir, 'tasks.md'));
  if (!text) return { ok: false, errors: [`Missing tasks.md.`] };
  if (!text.includes(SENTINEL)) {
    return {
      ok: false,
      errors: [
        `tasks.md is missing the memorize sentinel \`${SENTINEL}\`. After calling \`${ctx.memory.rememberTool}\` (and \`${ctx.memory.saveTool || '(no save tool)'}\`) to persist the task plan + traceability matrix, append \`${SENTINEL}\` to tasks.md.`,
      ],
    };
  }
  return { ok: true, summary: 'task plan memorized' };
}

function instructions(ctx) {
  if (!ctx.memory) {
    return [
      `# tasks-next — Phase 7 of 7: MEMORIZE`,
      `Ticket: ${ctx.ticket}`,
      '',
      'No memory plugin detected. Auto-advancing.',
      '',
    ].join('\n');
  }
  return [
    `# tasks-next — Phase 7 of 7: MEMORIZE (${ctx.memory.name})`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What you do',
    `Call \`${ctx.memory.rememberTool}\` (and \`${ctx.memory.saveTool || '(no save tool)'}\` if a save step is required) with at least:`,
    `- The task plan summary (count by kind, dependency graph shape).`,
    `- The traceability matrix (R-id → task numbers).`,
    `- Any sibling-owned files in \`### Files explicitly out of scope\` (helps future siblings know what was deferred).`,
    '',
    `When save call(s) return success, append \`${SENTINEL}\` to tasks.md.`,
    '',
    '### What I will check before advancing',
    `- tasks.md contains \`${SENTINEL}\``,
    '',
    'Re-invoke me to verify.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASKS_PHASES.memorize, {
    next: TASKS_PHASES.done,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.SENTINEL = SENTINEL;
