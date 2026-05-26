/**
 * Phase: report — verify qa-feature.check.md has the canonical structure.
 * Final-status check: must contain `Status: APPROVED` or `Status: BLOCKED`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { QA_PHASES } = require('../../qa-phase-registry');

const REQUIRED_SECTIONS = ['Smoke test', 'Feature tests', 'QA kind verification', 'Status'];

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function validate(ctx) {
  const p = path.join(ctx.tasksDir, 'qa-feature.check.md');
  const text = readFile(p);
  if (!text) return { ok: false, errors: [`Missing ${p}.`] };
  const missing = REQUIRED_SECTIONS.filter((s) => !text.includes(s));
  if (missing.length) {
    return {
      ok: false,
      errors: [`qa-feature.check.md missing section(s): ${missing.join(', ')}.`],
    };
  }
  if (!/Status:\s*(APPROVED|BLOCKED)\b/i.test(text)) {
    return {
      ok: false,
      errors: [
        'qa-feature.check.md final `Status:` line must be `APPROVED` or `BLOCKED`. Pick one based on whether all checklist items passed.',
      ],
    };
  }
  if (/Status:\s*BLOCKED/i.test(text)) {
    return {
      ok: false,
      errors: [
        'qa-feature.check.md final Status is BLOCKED. Resolve the failing items before advancing.',
      ],
    };
  }
  return { ok: true, summary: `${text.length} chars, APPROVED` };
}

function instructions(ctx) {
  return [
    '# qa-next — Phase 7 of 9: REPORT',
    `Ticket: ${ctx.ticket}`,
    '',
    `Finalize \`${path.join(ctx.tasksDir, 'qa-feature.check.md')}\` with sections: Smoke test, Feature tests, QA kind verification, Status. End the file with a single line:`,
    '',
    '```',
    'Status: APPROVED',
    '```',
    '',
    'If any kind validator blocked, write `Status: BLOCKED` instead and re-loop earlier phases.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(QA_PHASES.report, {
    next: QA_PHASES.memorize,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.REQUIRED_SECTIONS = REQUIRED_SECTIONS;
