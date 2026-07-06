/**
 * Step: 4b_gherkin_scope — post-implementation Gherkin scope validation
 * (GH-247, deterministic).
 *
 * Compares the spec.md-declared Gherkin scope (skip override + @unit /
 * @integration / @e2e scenario tags) against the COMMITTED diff of the
 * worktree (`git -C <worktree> diff --name-only origin/<BASE>...HEAD`).
 * Runs after 4_run_tests so the block fires only on an otherwise-green
 * implementation, before the phase-1 agents spend tokens on it.
 *
 * Verdicts:
 *   - PASS  → gherkin-scope.check.md written APPROVED, auto-advance
 *   - WARN  → APPROVED with a "## Warnings" section (spec.md absent /
 *             base unresolvable — warn, never block)
 *   - BLOCK → NEEDS_WORK naming the offending files + missing scenario
 *             type; the instruction directs transitioning back to the
 *             spec step to add the required scenarios.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { writeReportAtomic } = require('../report-utils');
const { runGherkinScopeCheck } = require('../gherkin-scope');

const REPORT_FILE = 'gherkin-scope.check.md';

function readSpecText(tasksDir) {
  try {
    return fs.readFileSync(path.join(tasksDir, 'spec.md'), 'utf8');
  } catch {
    return null;
  }
}

function declaredSection(declared) {
  const lines = ['## Declared Scope (spec.md)', ''];
  if (!declared.hasSpec) {
    lines.push('- spec.md: **absent**');
  } else {
    lines.push(
      `- gherkin-skip: ${declared.skip.skip ? `**yes** (${declared.skip.reason || 'no reason'})` : 'no'}`
    );
    lines.push(
      `- scenario tags: ${declared.tags.size > 0 ? [...declared.tags].sort().join(', ') : '(none)'}`
    );
  }
  lines.push('');
  return lines;
}

function changesSection(result) {
  const lines = ['## Actual Changes', ''];
  lines.push(`- base: ${result.baseRef || '(unresolvable)'}`);
  lines.push(`- committed files vs base: ${result.files.length}`);
  const b = result.buckets;
  for (const [label, arr] of [
    ['UI (.tsx/.jsx/.css)', b.ui],
    ['backend (routes/services/api/sql/migrations)', b.backend],
    ['tests', b.tests],
    ['docs/config', b.docsConfig],
    ['other', b.other],
  ]) {
    if (arr.length > 0) lines.push(`- ${label}: ${arr.length}`);
  }
  lines.push('');
  return lines;
}

function violationsSection(result) {
  if (result.violations.length === 0) return [];
  const lines = ['## Scope Mismatches', ''];
  for (const v of result.violations) {
    lines.push(`### Missing ${v.requiredTag} scenarios`);
    lines.push('');
    lines.push(`${v.why}:`);
    lines.push('');
    for (const f of v.files) lines.push(`- \`${f}\``);
    lines.push('');
  }
  lines.push(
    'Transition back to the **spec** step: add the required tagged scenarios to the',
    '`## Test Scenarios (Gherkin)` section of spec.md (or remove the `gherkin-skip`',
    'override if it no longer holds), then re-run the check.',
    ''
  );
  return lines;
}

function buildReport(result, changesHash) {
  const status = result.verdict === 'BLOCK' ? 'NEEDS_WORK' : 'APPROVED';
  const lines = [
    `**Status:** ${status}`,
    '',
    '# Gherkin Scope Validation (GH-247)',
    '',
    `**Verdict:** ${result.verdict}`,
    '',
    ...result.reasons.map((r) => `- ${r}`),
    '',
    ...declaredSection(result.declared),
    ...changesSection(result),
    ...violationsSection(result),
  ];
  if (result.verdict === 'WARN') {
    lines.push('## Warnings', '', ...result.reasons.map((r) => `- ${r}`), '');
  }
  lines.push(`Verified at ${changesHash}`);
  return lines.join('\n');
}

module.exports = function registerGherkinScope(register) {
  register('4b_gherkin_scope', (state, ctx) => {
    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;
    const reportPath = path.join(reportFolder, REPORT_FILE);
    const changesHash = state.changesHash || 'unknown';

    // Off-switch (CHECK_GHERKIN_SCOPE=0), consistent with CHECK_FLAKE_RETRY /
    // CHECK_IMPACT_TESTS: the step auto-passes with a note.
    if (process.env.CHECK_GHERKIN_SCOPE === '0') {
      writeReportAtomic(
        reportPath,
        [
          '**Status:** APPROVED',
          '',
          '# Gherkin Scope Validation (GH-247)',
          '',
          '**Verdict:** SKIPPED',
          '',
          '- Disabled via `CHECK_GHERKIN_SCOPE=0` — declared-scope vs actual-diff validation not performed.',
          '',
          `Verified at ${changesHash}`,
        ].join('\n')
      );
      return null; // auto-advance
    }

    let result;
    try {
      result = runGherkinScopeCheck({
        specText: readSpecText(ctx.tasksDir),
        // Cwd-independent worktree resolution (PR #669 review): the ticket id
        // resolves the worktree via the shared WORKTREES_BASE/REPO_NAME
        // convention, so an orchestrator running outside the ticket worktree
        // (tasks dir, plugin checkout) can't diff the wrong repo.
        ticketId: state.ticketId,
      });
    } catch (err) {
      // Fail-open: an internal error must not brick the check pipeline.
      result = {
        verdict: 'WARN',
        reasons: [`Gherkin scope validator errored (${err.message}) — skipped, warn only.`],
        violations: [],
        buckets: { ui: [], backend: [], tests: [], docsConfig: [], other: [] },
        declared: { hasSpec: false, skip: { skip: false }, tags: new Set() },
        worktree: null,
        baseRef: null,
        files: [],
      };
    }

    writeReportAtomic(reportPath, buildReport(result, changesHash));

    if (result.verdict === 'BLOCK') {
      return {
        type: 'check_instruction',
        action: 'failed',
        state: { ticket: state.ticketId, currentStep: '4b_gherkin_scope' },
        reason:
          `${result.reasons.join(' | ')}. ` +
          `The implementation's actual scope exceeds what spec.md declared — transition back to the ` +
          `spec step and add the missing tagged scenario(s) to \`## Test Scenarios (Gherkin)\` ` +
          `(or drop the gherkin-skip override), then re-run /check.`,
        report: reportPath,
      };
    }

    return null; // PASS / WARN → auto-advance
  });
};

module.exports.REPORT_FILE = REPORT_FILE;
module.exports.buildReport = buildReport;
