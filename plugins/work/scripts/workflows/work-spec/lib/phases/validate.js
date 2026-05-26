/**
 * Phase: validate — cross-check spec.md against brief.md.
 *
 * - Every P0 requirement in brief.md must be addressed in spec.md (by
 *   reference or restated). Uses `lib/brief-spec-coverage.js`.
 * - Re-runs the surface_audit checks as a belt-and-braces safety net in
 *   case spec drifted after the dedicated surface_audit phase.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { SPEC_PHASES } = require('../../spec-phase-registry');
const surfaceAudit = require('./surface_audit');

let briefSpecCoverage;
try {
  briefSpecCoverage = require('../../../lib/brief-spec-coverage');
} catch (e) {
  if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
  briefSpecCoverage = null;
}

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function runCoverageCheck(tasksDir) {
  const errors = [];
  if (!briefSpecCoverage) return errors;
  const brief = readFile(path.join(tasksDir, 'brief.md'));
  const spec = readFile(path.join(tasksDir, 'spec.md'));
  if (!brief || !spec) {
    errors.push(`Cannot run brief↔spec coverage: missing brief.md or spec.md.`);
    return errors;
  }
  try {
    const result = briefSpecCoverage.checkCoverage
      ? briefSpecCoverage.checkCoverage(brief, spec)
      : null;
    if (result && Array.isArray(result.gaps) && result.gaps.length > 0) {
      for (const g of result.gaps) errors.push(`Coverage gap: ${g}`);
    }
  } catch (e) {
    // brief-spec-coverage's API may differ across plugin versions — fail open
    // rather than block the workflow on an integration mismatch.
    errors.push(`brief-spec-coverage check failed: ${e.message}`);
  }
  return errors;
}

function validate(ctx) {
  const errors = [];
  // Run surface_audit again — cheap, catches drift.
  const sav = surfaceAudit.validate(ctx);
  if (!sav.ok && Array.isArray(sav.errors)) errors.push(...sav.errors);
  // Cross-check brief↔spec coverage.
  errors.push(...runCoverageCheck(ctx.tasksDir));
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, summary: 'brief↔spec coverage + surface re-audit ok' };
}

function instructions(ctx) {
  return [
    `# spec-next — Phase 5 of 8: VALIDATE`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What I check',
    '- Every sibling-owned identifier referenced in spec.md still resolves (re-runs surface_audit).',
    '- spec.md addresses every P0 from brief.md.',
    '',
    'If validation passes, I record + advance to MEMORIZE. If it fails, I print the gaps and you fix the spec.',
    '',
    'Re-invoke me to run the check.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(SPEC_PHASES.validate, {
    next: SPEC_PHASES.memorize,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.runCoverageCheck = runCoverageCheck;
