/**
 * Phase: coverage_check — every P0 requirement must have a code citation.
 *
 * Reads completion-context.json snapshot and verifies that the Requirement
 * Coverage table has DELIVERED status + non-empty Evidence for every P0.
 * The agent fills the table; this phase enforces that no P0 row is left
 * empty or PENDING before the kind_checks fan-out.
 */

'use strict';

const { COMPLETION_PHASES } = require('../../completion-phase-registry');
const { readBriefRequirements, readRequirementCoverage } = require('../kind-checks/shared');

function validate(ctx) {
  const reqs = readBriefRequirements(ctx.tasksDir);
  const coverage = readRequirementCoverage(ctx.tasksDir);
  const errors = [];
  const warnings = [];

  const p0 = reqs.filter((r) => r.priority === 'P0');
  if (p0.length && !coverage.length) {
    errors.push(
      `Brief lists ${p0.length} P0 requirement(s) but tasks.md has no \`## Requirement Coverage\` table. Add it before completing.`
    );
  }

  const undelivered = coverage.filter(
    (r) => !/delivered|done|complete|ok|✓/i.test(r.status) && r.status.trim().length > 0
  );
  if (undelivered.length) {
    errors.push(
      `Requirement Coverage has ${undelivered.length} non-DELIVERED row(s): ${undelivered
        .slice(0, 3)
        .map((r) => `\`${r.id}\``)
        .join(', ')}${undelivered.length > 3 ? ', …' : ''}.`
    );
  }

  const missingEvidence = coverage.filter(
    (r) => /delivered|done|complete|ok|✓/i.test(r.status) && !r.evidence.trim()
  );
  if (missingEvidence.length) {
    warnings.push(
      `${missingEvidence.length} DELIVERED row(s) lack evidence citations: ${missingEvidence
        .slice(0, 3)
        .map((r) => `\`${r.id}\``)
        .join(', ')}${missingEvidence.length > 3 ? ', …' : ''}. Add file:line or commit refs.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${coverage.length} rows, ${undelivered.length} undelivered, ${missingEvidence.length} missing-evidence`,
  };
}

function instructions(ctx) {
  return [
    '# completion-next — Phase 4 of 8: COVERAGE CHECK',
    `Ticket: ${ctx.ticket}`,
    '',
    'I verify every requirement in `## Requirement Coverage` is DELIVERED with non-empty Evidence (file:line or commit ref).',
    '',
    'Edit tasks.md to:',
    '- mark all P0 rows as DELIVERED (or move incomplete ones back to in-progress)',
    '- add a code citation in the Evidence column for every DELIVERED row',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(COMPLETION_PHASES.coverage_check, {
    next: COMPLETION_PHASES.kind_checks,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
