/**
 * Phase: smoke — happy-path smoke section in qa-feature.check.md.
 *
 * Gate: report contains `## Smoke test` section with at least one checked
 * box. Smoke just confirms the feature loads and the basic happy path
 * works before the per-kind deep dives.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { QA_PHASES } = require('../../qa-phase-registry');

const SECTION_HEADER = '## Smoke test';

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function validate(ctx) {
  const report = readFile(path.join(ctx.tasksDir, 'qa-feature.check.md'));
  if (!report || !report.includes(SECTION_HEADER)) {
    return {
      ok: false,
      errors: [
        `qa-feature.check.md missing \`${SECTION_HEADER}\` section. Add it with the happy-path steps you exercised.`,
      ],
    };
  }
  // Slice to next ## heading
  const idx = report.indexOf(SECTION_HEADER);
  const after = report.slice(idx + SECTION_HEADER.length);
  const next = after.match(/^##\s/m);
  const block = next ? after.slice(0, next.index) : after;
  const checked = (block.match(/^- \[[xX]\]/gm) || []).length;
  if (checked === 0) {
    return {
      ok: false,
      errors: [
        'Smoke test section has no `- [x]` checked items. Drive the happy path in the browser and check each step.',
      ],
    };
  }
  return { ok: true, summary: `${checked} smoke step(s) confirmed` };
}

function instructions(ctx) {
  return [
    '# qa-next — Phase 3 of 9: SMOKE',
    `Ticket: ${ctx.ticket}`,
    '',
    'Drive the happy path in the browser. Record each step as a checklist item under',
    `\`## Smoke test\` in \`${path.join(ctx.tasksDir, 'qa-feature.check.md')}\`. Example:`,
    '',
    '```',
    '## Smoke test',
    '- [x] Navigated to /admin/external-asset/abc',
    '- [x] Section "Tables and Objects (3)" rendered',
    '- [x] Selecting a row toggled the checkbox',
    '```',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(QA_PHASES.smoke, {
    next: QA_PHASES.feature,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.SECTION_HEADER = SECTION_HEADER;
