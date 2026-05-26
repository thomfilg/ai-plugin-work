/**
 * Phase: feature — verify the agent has tested every P0 acceptance
 * criterion from tasks.md. Gate: `## Feature tests` section exists and
 * has at least one checked item per task's Acceptance Criteria block.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { QA_PHASES } = require('../../qa-phase-registry');
const { readTasks } = require('../kind-checks/shared');

const SECTION_HEADER = '## Feature tests';

function countAcceptanceCriteria(tasksText) {
  if (!tasksText) return 0;
  // Crude: count `### Acceptance Criteria` headings, each represents one task.
  const matches = tasksText.match(/^###\s+Acceptance Criteria\b/gim) || [];
  return matches.length;
}

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
        `qa-feature.check.md missing \`${SECTION_HEADER}\` section. Add a checklist covering each P0 acceptance criterion from tasks.md.`,
      ],
    };
  }
  const idx = report.indexOf(SECTION_HEADER);
  const after = report.slice(idx + SECTION_HEADER.length);
  const next = after.match(/^##\s/m);
  const block = next ? after.slice(0, next.index) : after;
  const checked = (block.match(/^- \[[xX]\]/gm) || []).length;
  const total = (block.match(/^- \[[ xX]\]/gm) || []).length;

  const expected = countAcceptanceCriteria(readTasks(ctx.tasksDir));
  const errors = [];
  const warnings = [];
  if (total === 0) {
    errors.push(`\`${SECTION_HEADER}\` has no checklist items.`);
  } else if (checked < total) {
    errors.push(`Feature tests: ${checked}/${total} items checked.`);
  }
  if (expected && total < expected) {
    warnings.push(
      `tasks.md has ${expected} acceptance-criteria block(s) but the feature checklist has only ${total} item(s). Add coverage for the gap.`
    );
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `Feature: ${checked}/${total} checked${expected ? ` (${expected} expected)` : ''}`,
  };
}

function instructions(ctx) {
  return [
    '# qa-next — Phase 4 of 9: FEATURE',
    `Ticket: ${ctx.ticket}`,
    '',
    `Under \`${SECTION_HEADER}\` in qa-feature.check.md, add a checklist that maps to every Acceptance Criteria block in tasks.md. Drive each one in the browser and check the box only after verifying.`,
    '',
    'Skip nothing — partial verification is not verification.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(QA_PHASES.feature, {
    next: QA_PHASES.kind_checks,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.SECTION_HEADER = SECTION_HEADER;
