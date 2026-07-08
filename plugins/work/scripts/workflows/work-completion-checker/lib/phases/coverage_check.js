/**
 * Phase: coverage_check — every P0 requirement must have a code citation.
 *
 * Reads completion-context.json snapshot and verifies that the Requirement
 * Coverage table has DELIVERED status + non-empty Evidence for every P0.
 * The agent fills the table; this phase enforces that no P0 row is left
 * empty or PENDING before the kind_checks fan-out.
 *
 * Deadlock hardening (ECHO-5139/5145/5218/5320/5350/5818/5821 family):
 *   - As-authored Status values (Covered, Verified, Verified N/A, Respected,
 *     N/A, …) count as delivered — split-in-tasks authors the table before
 *     completion evidence exists, so demanding a literal DELIVERED forced a
 *     tasks.md rewrite that protect-tasks-md then blocked.
 *   - When tasks.md has no coverage source at all but completion-context.json
 *     or completion.check.md supplies one, degrade to a WARNING (never an
 *     unrecoverable block).
 *   - When a tasks.md repair IS required, mint a one-shot write token
 *     (lib/tasks-md-write-token.js) that the protect-tasks-md hook honors, so
 *     there is always a permitted path to fix the artifact.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { COMPLETION_PHASES } = require('../../completion-phase-registry');
const {
  readBriefRequirements,
  readRequirementCoverage,
  parseCoverageTableRow,
} = require('../kind-checks/shared');
const { mintTasksMdWriteToken, TOKEN_MAX_AGE_MS } = require('../../../lib/tasks-md-write-token');

/**
 * Status tokens that count as "delivered". Beyond the historical
 * /delivered|done|complete|ok|✓/ set, accept the statuses split-in-tasks and
 * completion agents actually author (ECHO-5818): Covered, Verified,
 * "Verified N/A", Respected, and a whole-cell N/A / NA.
 */
// Exact-token matching (word boundaries via non-letter/digit edges) so
// negated/partial statuses never count: "Uncovered" must NOT match "covered",
// "incomplete" must NOT match "complete".
const DELIVERED_TOKEN_RE =
  /(^|[^a-z0-9])(delivered|done|completed?|ok|covered|verified|respected)(?=$|[^a-z0-9])/i;
// Explicit negation/partial rejection: "Not covered", "NOT VERIFIED",
// "partially covered", "pending", "missing", and un-prefixed token forms.
const NEGATED_STATUS_RE =
  /(^|[^a-z0-9])(not?|never|partial(?:ly)?|pending|missing|incomplete|un(?:delivered|done|completed?|covered|verified|respected))(?=$|[^a-z0-9])/i;

function isDeliveredStatus(status) {
  const s = String(status || '').trim();
  if (!s) return false;
  if (/^n\/?a$/i.test(s)) return true; // whole-cell "N/A" / "NA"
  if (NEGATED_STATUS_RE.test(s)) return false;
  return DELIVERED_TOKEN_RE.test(s) || s.includes('✓');
}

/**
 * Fallback coverage sources, consulted only when tasks.md yields zero rows
 * (neither table nor `### Requirements Covered` subsections):
 *   1. completion-context.json `coverage` array (runner snapshot — an agent
 *      may legitimately have supplied coverage there when tasks.md is
 *      write-protected)
 *   2. a `## Requirement Coverage` table inside completion.check.md
 *
 * @returns {{ rows: Array<object>, source: string } | null}
 */
function readFallbackCoverage(tasksDir) {
  try {
    const ctxFile = JSON.parse(
      fs.readFileSync(path.join(tasksDir, 'completion-context.json'), 'utf8')
    );
    if (Array.isArray(ctxFile.coverage) && ctxFile.coverage.length) {
      return { rows: ctxFile.coverage, source: 'completion-context.json' };
    }
  } catch {
    /* absent or unparseable — try the next source */
  }
  try {
    const report = fs.readFileSync(path.join(tasksDir, 'completion.check.md'), 'utf8');
    const rows = report.split('\n').map(parseCoverageTableRow).filter(Boolean);
    if (rows.length) return { rows, source: 'completion.check.md' };
  } catch {
    /* absent — no fallback */
  }
  return null;
}

/**
 * Coverage rows for validation: tasks.md first; when it yields zero rows and
 * P0 requirements exist, degrade to a fallback source (warning) or error out.
 * Pushes onto errors/warnings; returns the rows to validate.
 */
function resolveCoverageRows(ctx, p0Count, errors, warnings) {
  const coverage = readRequirementCoverage(ctx.tasksDir);
  if (!p0Count || coverage.length) return coverage;

  const fallback = readFallbackCoverage(ctx.tasksDir);
  if (fallback) {
    // Degrade gracefully — coverage exists, just not in tasks.md.
    warnings.push(
      `requirement_coverage_fallback: tasks.md has no '## Requirement Coverage' table; using ${fallback.rows.length} row(s) from ${fallback.source}. Re-run split-in-tasks next time so the canonical table lands in tasks.md.`
    );
    return fallback.rows;
  }
  errors.push(
    "requirement_coverage_missing: no '## Requirement Coverage' table and no per-task '### Requirements Covered' subsections found in tasks.md. Re-run the split-in-tasks step to regenerate tasks.md."
  );
  return coverage;
}

/**
 * Every coverage error demands a tasks.md repair, but protect-tasks-md blocks
 * tasks.md writes during the `check` step. Mint a one-shot write token so the
 * agent has a legitimate path to fix the artifact (ECHO-5818's preferred fix).
 * Best-effort: re-running this phase re-mints.
 */
function mintRepairToken(ctx, errors) {
  if (!errors.length || !ctx.ticket) return;
  const minted = mintTasksMdWriteToken(ctx.ticket, { reason: 'coverage_check' });
  if (minted) {
    errors.push(
      `A one-shot tasks.md write token was minted for ${ctx.ticket} (valid ${Math.round(
        TOKEN_MAX_AGE_MS / 60000
      )} min). The protect-tasks-md hook will allow exactly ONE tasks.md write so you can repair the coverage table. Re-run completion-next.js to re-mint if it expires.`
    );
  }
}

function validate(ctx) {
  const reqs = readBriefRequirements(ctx.tasksDir);
  const errors = [];
  const warnings = [];

  const p0 = reqs.filter((r) => r.priority === 'P0');
  const coverage = resolveCoverageRows(ctx, p0.length, errors, warnings);

  const undelivered = coverage.filter(
    (r) => !isDeliveredStatus(r.status) && String(r.status || '').trim().length > 0
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
    (r) => isDeliveredStatus(r.status) && !String(r.evidence || '').trim()
  );
  if (missingEvidence.length) {
    warnings.push(
      `${missingEvidence.length} DELIVERED row(s) lack evidence citations: ${missingEvidence
        .slice(0, 3)
        .map((r) => `\`${r.id}\``)
        .join(', ')}${missingEvidence.length > 3 ? ', …' : ''}. Add file:line or commit refs.`
    );
  }

  mintRepairToken(ctx, errors);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${coverage.length} rows, ${undelivered.length} undelivered, ${missingEvidence.length} missing-evidence`,
  };
}

function instructions(ctx) {
  return [
    '# completion-next — Phase 4 of 11: COVERAGE CHECK',
    `Ticket: ${ctx.ticket}`,
    '',
    'I verify every requirement in `## Requirement Coverage` is DELIVERED (accepted statuses: DELIVERED, DONE, COMPLETE, OK, Covered, Verified, Verified N/A, Respected, N/A, ✓) with non-empty Evidence (file:line or commit ref).',
    '',
    'If a repair is needed, edit tasks.md to:',
    '- mark all P0 rows as DELIVERED (or move incomplete ones back to in-progress)',
    '- add a code citation in the Evidence column for every DELIVERED row',
    '',
    'When I block with a tasks.md repair demand, I mint a ONE-SHOT tasks.md write token that the protect-tasks-md hook honors — your next tasks.md write for this ticket is allowed even during the `check` step. If the write is still blocked, re-run me to re-mint.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(COMPLETION_PHASES.coverage_check, {
    next: COMPLETION_PHASES.reuse_audit_enforcement,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.isDeliveredStatus = isDeliveredStatus;
module.exports.readFallbackCoverage = readFallbackCoverage;
