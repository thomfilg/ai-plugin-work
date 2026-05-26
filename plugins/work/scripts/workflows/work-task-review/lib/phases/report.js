/**
 * Phase: report — confirm task-review.check.md exists with required sections.
 *
 * Required sections: Summary, Diff audit, Reuse check, Per-kind verification.
 * Must end with `Status: APPROVED` or `Status: BLOCKED`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { TASK_REVIEW_PHASES } = require('../../task-review-phase-registry');

const REPORT_FILE = 'task-review.check.md';
const REQUIRED_SECTIONS = [
  /^##\s+Summary\b/im,
  /^##\s+Diff audit\b/im,
  /^##\s+Reuse check\b/im,
  /^##\s+Per-kind verification\b/im,
];
const STATUS_RE = /^Status:\s*(APPROVED|BLOCKED)\b/im;

function validate(ctx) {
  const p = path.join(ctx.tasksDir, REPORT_FILE);
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      errors: [
        `\`${REPORT_FILE}\` missing. Write Summary / Diff audit / Reuse check / Per-kind verification + Status: APPROVED|BLOCKED.`,
      ],
    };
  }
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return { ok: false, errors: [`could not read \`${REPORT_FILE}\`: ${e.message}`] };
  }
  const missing = [];
  if (!REQUIRED_SECTIONS[0].test(text)) missing.push('## Summary');
  if (!REQUIRED_SECTIONS[1].test(text)) missing.push('## Diff audit');
  if (!REQUIRED_SECTIONS[2].test(text)) missing.push('## Reuse check');
  if (!REQUIRED_SECTIONS[3].test(text)) missing.push('## Per-kind verification');
  if (missing.length) {
    return {
      ok: false,
      errors: [`\`${REPORT_FILE}\` missing section(s): ${missing.join(', ')}.`],
    };
  }
  if (!STATUS_RE.test(text)) {
    return {
      ok: false,
      errors: [
        `\`${REPORT_FILE}\` missing final \`Status: APPROVED\` or \`Status: BLOCKED\` line.`,
      ],
    };
  }
  return { ok: true, summary: 'task-review.check.md complete' };
}

function instructions(ctx) {
  return [
    '# task-review-next — Phase 6 of 8: REPORT',
    `Ticket: ${ctx.ticket}`,
    '',
    'Write `task-review.check.md` with:',
    '  ## Summary',
    '  ## Diff audit',
    '  ## Reuse check',
    '  ## Per-kind verification  (kind_checks phase auto-injects this)',
    '  Status: APPROVED | Status: BLOCKED',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASK_REVIEW_PHASES.report, {
    next: TASK_REVIEW_PHASES.memorize,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.REPORT_FILE = REPORT_FILE;
