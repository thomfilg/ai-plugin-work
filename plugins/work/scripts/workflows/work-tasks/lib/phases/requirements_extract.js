/**
 * Phase: requirements_extract — enforce that tasks.md begins with a
 * `## Extracted Requirements` section listing every requirement as a
 * numbered ID (R1..Rn). This is the spine the traceability phase
 * relies on.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { TASKS_PHASES } = require('../../tasks-phase-registry');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function sliceSection(text, headerRe) {
  if (!text) return '';
  const m = text.match(headerRe);
  if (!m) return '';
  const after = text.slice(m.index + m[0].length);
  const next = after.match(/^##\s/m);
  return next ? after.slice(0, next.index) : after;
}

function listRequirementIds(text) {
  if (!text) return [];
  // Match "R1", "R10", "R-3", "spec §2.1", "brief AC-3", "AC1"
  const out = new Set();
  const re = /\b(R-?\d+|AC-?\d+|spec\s*§[\d.]+|brief\s+AC-\d+)\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[0]);
  return [...out];
}

function validateArtifacts(tasksDir) {
  const errors = [];
  const p = path.join(tasksDir, 'tasks.md');
  const text = readFile(p);
  if (!text) {
    errors.push(
      `Missing ${p}. Create it with a top section \`## Extracted Requirements\` listing every requirement before drafting tasks.`
    );
    return errors;
  }
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
  const text = readFile(path.join(ctx.tasksDir, 'tasks.md'));
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
