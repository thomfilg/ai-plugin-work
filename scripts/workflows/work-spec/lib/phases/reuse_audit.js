/**
 * Phase: reuse_audit — enforce the existing "Reuse Audit" section of spec.md.
 *
 * Validates that spec.md contains a `## Reuse Audit` section listing existing
 * helpers/components considered before proposing new code. This mirrors the
 * spec-writer agent prompt requirement.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { SPEC_PHASES } = require('../../spec-phase-registry');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function sliceSection(text, headerRe) {
  const m = text.match(headerRe);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length);
  const next = after.match(/^##\s/m);
  return next ? after.slice(0, next.index) : after;
}

function validateArtifacts(tasksDir) {
  const errors = [];
  const specPath = path.join(tasksDir, 'spec.md');
  const spec = readFile(specPath);
  if (!spec) {
    errors.push(
      `Missing ${specPath}. spec.md must exist by the end of the draft phase, but a stub is required here so reuse_audit has somewhere to land.`
    );
    return errors;
  }
  const reuse = sliceSection(spec, /^##\s+Reuse Audit(?=\s|$)/im);
  if (!reuse || reuse.trim().length < 30) {
    errors.push(
      `spec.md is missing a non-trivial \`## Reuse Audit\` section (< 30 chars). List the existing helpers/components/types you considered (with file:line references) before proposing new code.`
    );
  }
  return errors;
}

function validate(ctx) {
  const errors = validateArtifacts(ctx.tasksDir);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, summary: 'reuse audit recorded' };
}

function instructions(ctx) {
  const { ticket, tasksDir } = ctx;
  return [
    `# spec-next — Phase 2 of 8: REUSE AUDIT`,
    `Ticket: ${ticket}`,
    '',
    '### What you do',
    `Create or edit \`${path.join(tasksDir, 'spec.md')}\` and ensure it has a section:`,
    '',
    '```markdown',
    '## Reuse Audit',
    '',
    '- `path/to/existing/helper.ts:42` — already does X; reused here.',
    '- `components/foo/Bar.tsx` — covers the empty-state pattern; mirror it.',
    '- (none found for Y — explicit miss, propose new code in §Files to Create/Modify)',
    '```',
    '',
    'Audit must be concrete: include file paths and line numbers where applicable. List both REUSED items and EXPLICIT MISSES (so reviewers can challenge whether the miss is real).',
    '',
    '### What I will check before advancing',
    `- \`spec.md\` exists`,
    `- \`## Reuse Audit\` section present with ≥ 30 chars of content`,
    '',
    'Re-invoke me to verify.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(SPEC_PHASES.reuse_audit, {
    next: SPEC_PHASES.surface_audit,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.validateArtifacts = validateArtifacts;
