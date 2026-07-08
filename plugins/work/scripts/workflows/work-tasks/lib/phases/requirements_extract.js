/**
 * Phase: requirements_extract — enforce that tasks.md begins with a
 * `## Extracted Requirements` section listing every requirement as a
 * numbered ID (R1..Rn). This is the spine the traceability phase
 * relies on.
 */

'use strict';

const path = require('node:path');

const { TASKS_PHASES } = require('../../tasks-phase-registry');
const { loadTasksMd, readFileSafe, tasksMdPath } = require('./_tasks-md-loader');
const { sliceSection } = require('../../../work-spec/lib/kind-checks/shared');
// Canonical grammar shared with the completion-checker coverage fallback —
// keeping both sides on one module prevents the #498 drift (generator
// accepts a format the checker rejects).
const { listRequirementIds } = require('../../../lib/requirement-ids');

function validateArtifacts(tasksDir) {
  const { text, errors } = loadTasksMd(
    tasksDir,
    (p) =>
      `Missing ${p}. Create it with a top section \`## Extracted Requirements\` listing every requirement before drafting tasks.`
  );
  if (text === null) return errors;
  const section = sliceSection(text, /^##\s+Extracted Requirements(?=\s|$)/im);
  if (!section || section.trim().length < 30) {
    errors.push(
      `tasks.md is missing a non-trivial \`## Extracted Requirements\` section. List every brief+spec requirement with a stable ID (R1, R2, ...).`
    );
    return errors;
  }
  const ids = listRequirementIds(section);
  if (ids.length === 0) {
    errors.push(
      `\`## Extracted Requirements\` has no recognizable IDs (R1, R2, AC1, spec §2.1, brief AC-3). Add stable IDs so tasks can reference them.`
    );
  }
  return errors;
}

function validate(ctx) {
  const errors = validateArtifacts(ctx.tasksDir);
  if (errors.length) return { ok: false, errors };
  const text = readFileSafe(tasksMdPath(ctx.tasksDir));
  const ids = listRequirementIds(sliceSection(text, /^##\s+Extracted Requirements(?=\s|$)/im));
  return { ok: true, summary: `${ids.length} requirement IDs extracted` };
}

function instructions(ctx) {
  return [
    `# tasks-next — Phase 2 of 7: REQUIREMENTS EXTRACT`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What you do',
    `Create \`${path.join(ctx.tasksDir, 'tasks.md')}\` with a top section:`,
    '',
    '```markdown',
    '## Extracted Requirements',
    '',
    '- R1 — <restate exactly one functional or non-functional requirement>',
    '- R2 — <next>',
    '- AC1 — <acceptance criterion from brief>',
    '- spec §2.1 — <constraint from spec>',
    '```',
    '',
    'IDs are stable — every task you create later will reference one or more of these. Cover EVERY brief P0/P1 + every spec constraint. Use spec/brief numbering when present; otherwise use sequential R-IDs.',
    '',
    '### What I will check before advancing',
    '- `tasks.md` exists',
    '- `## Extracted Requirements` section present, ≥ 30 chars',
    '- At least one recognizable ID (R\\d+ / AC\\d+ / spec §x.y / brief AC-x)',
    '',
    'Re-invoke me to verify.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASKS_PHASES.requirements_extract, {
    next: TASKS_PHASES.draft,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.validateArtifacts = validateArtifacts;
module.exports.listRequirementIds = listRequirementIds;
module.exports.sliceSection = sliceSection;
