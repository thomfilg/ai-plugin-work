/**
 * Phase: draft — produce the full spec.md.
 *
 * Validates the required spec sections exist. The agent (spec-writer) does
 * the actual writing; this phase gates transition until the artifact is
 * complete enough.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { SPEC_PHASES } = require('../../spec-phase-registry');

const REQUIRED_SECTIONS = [
  'Summary',
  'Architecture Decisions',
  'API/Interface Changes',
  'Test Scenarios',
  'Files to Create/Modify',
];

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function hasSection(text, name) {
  const re = new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'im');
  return re.test(text);
}

function validateArtifacts(tasksDir) {
  const errors = [];
  const specPath = path.join(tasksDir, 'spec.md');
  const spec = readFile(specPath);
  if (!spec) {
    errors.push(`Missing ${specPath}.`);
    return errors;
  }
  for (const name of REQUIRED_SECTIONS) {
    if (!hasSection(spec, name))
      errors.push(`spec.md is missing required section: \`## ${name}\`.`);
  }
  return errors;
}

function validate(ctx) {
  const errors = validateArtifacts(ctx.tasksDir);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, summary: 'all required spec sections present' };
}

function instructions(ctx) {
  const { ticket, tasksDir } = ctx;
  return [
    `# spec-next — Phase 4 of 8: DRAFT`,
    `Ticket: ${ticket}`,
    '',
    '### What you do',
    `Complete \`${path.join(tasksDir, 'spec.md')}\`. Required sections:`,
    '',
    REQUIRED_SECTIONS.map((s) => `- \`## ${s}\``).join('\n'),
    '',
    'Also recommended (not gated here, but spec_gate may check):',
    '- `## Data Model Changes`',
    '- `## Security Considerations`',
    '- `## Open Questions & Decisions`',
    '- `## Dependencies`',
    '',
    'Reference brief.md for P0/P1 + hard constraints. Reference `## Verified sibling surface` (recorded by the previous phase) when describing API/Interface Changes — do NOT invent fields that were not verified.',
    '',
    '### What I will check before advancing',
    REQUIRED_SECTIONS.map((s) => `- \`## ${s}\` header is present`).join('\n'),
    '',
    'Re-invoke me when the sections are filled.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(SPEC_PHASES.draft, {
    next: SPEC_PHASES.validate,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.validateArtifacts = validateArtifacts;
module.exports.REQUIRED_SECTIONS = REQUIRED_SECTIONS;
