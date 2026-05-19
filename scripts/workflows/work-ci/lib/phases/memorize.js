/**
 * Phase: memorize — persist CI patterns (known flakes, recurring
 * pre-existing failures) to memory plugin. Sentinel: ci-triage.json
 * contains `"memorized": true`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CI_PHASES } = require('../../ci-phase-registry');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function validate(ctx) {
  if (!ctx.memory) return { ok: true, summary: 'no memory plugin — auto-passing' };
  const triage = readJson(path.join(ctx.tasksDir, 'ci-triage.json'));
  if (!triage) return { ok: true, summary: 'no triage file — nothing to memorize' };
  if (triage.memorized !== true) {
    return {
      ok: false,
      errors: [
        `ci-triage.json does not have \`"memorized": true\`. After calling \`${ctx.memory.rememberTool}\` with the failure classifications (esp. flakes + pre-existing), set "memorized": true in ci-triage.json.`,
      ],
    };
  }
  return { ok: true, summary: 'CI patterns memorized' };
}

function instructions(ctx) {
  if (!ctx.memory)
    return [
      `# ci-next — Phase 6 of 7: MEMORIZE`,
      `Ticket: ${ctx.ticket}`,
      '',
      'No memory plugin. Auto-advancing.',
      '',
    ].join('\n');
  return [
    `# ci-next — Phase 6 of 7: MEMORIZE (${ctx.memory.name})`,
    `Ticket: ${ctx.ticket}`,
    '',
    `Call \`${ctx.memory.rememberTool}\` with the failure classifications from ci-triage.json (especially \`flake\` and \`pre-existing\` entries — these are the most valuable for future tickets).`,
    '',
    'When the save completes, set `"memorized": true` in ci-triage.json.',
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(CI_PHASES.memorize, {
    next: CI_PHASES.done,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
