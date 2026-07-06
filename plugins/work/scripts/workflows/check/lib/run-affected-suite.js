/**
 * Shared step body for the "run affected suite" check steps
 * (8_run_integration, 9_run_e2e). The two steps differ only in env var,
 * step id, report filename, label, timeout — everything else (skip when
 * unconfigured, run the command, classify the outcome, write the report,
 * fail on non-zero exit) is identical, so it lives here once.
 *
 * GH-394 additions:
 * - crash-vs-fail classification via test-run-analysis (a runner OOM/worker
 *   crash reports CRASHED with the signature quoted, never "all tests failed")
 * - e2e spec scoping (`scopeSpecs: true`): exports CHANGED_SPECS (strictly
 *   changed spec files + importers of changed helpers) and
 *   E2E_PER_SPEC_TIMEOUT_MS to the suite command, and notes skipped siblings
 *   in the report (echo-5224 reliability-gate sweep).
 */

'use strict';

const path = require('path');
// Reuse the single command runner from run-tests.js rather than spawning here —
// one combined-output exec site for the whole /check subsystem.
const { runCommand } = require('./steps/run-tests');
const { writeReportAtomic } = require('./report-utils');
const { classifyRun } = require('./test-run-analysis');
const { computeChangedSpecs, buildE2eEnv } = require('./changed-specs');

// "## Spec Scoping" report section (echo-5224): what CHANGED_SPECS was scoped
// to, which unchanged importers were kept, and which siblings were NOT swept.
function scopingSection(scoped) {
  if (!scoped.baseRef) {
    return [
      '## Spec Scoping',
      '',
      'Base ref unresolvable — CHANGED_SPECS not exported (suite ran unscoped, same as before).',
      '',
    ];
  }
  const lines = ['## Spec Scoping', ''];
  lines.push(`**Base:** ${scoped.baseRef}`);
  lines.push(`**Scoped specs (${scoped.specs.length}):**`);
  for (const s of scoped.changedSpecs) lines.push(`- ${s} (changed)`);
  for (const s of scoped.keptImporters)
    lines.push(`- ${s} (unchanged, kept — imports a changed helper)`);
  if (scoped.specs.length === 0) lines.push('- none (no spec files changed vs base)');
  if (scoped.skippedSiblings.length > 0) {
    lines.push('');
    lines.push(
      `**Skipped siblings (${scoped.skippedSiblings.length})** — unchanged specs in the same directories, NOT swept:`
    );
    for (const s of scoped.skippedSiblings) lines.push(`- ${s}`);
  }
  lines.push('');
  return lines;
}

function buildReport({ status, outcome, label, envVar, exitCode, analysis, output, scoped }) {
  const lines = [
    `**Status:** ${status}`,
    '',
    `# ${label} Test Results`,
    '',
    `**Result:** ${outcome}`,
    `**Runner:** ${envVar}`,
    `**Exit code:** ${exitCode}`,
    `**Pass:** ${analysis.counts.passed ?? '?'} | **Fail:** ${analysis.counts.failed ?? '?'}`,
    '',
  ];

  if (outcome === 'CRASHED') {
    lines.push(
      '## Crash Signature',
      '',
      'The test RUNNER crashed — infrastructure failure, not a test failure.',
      `> "${analysis.crashSignature}"`,
      ''
    );
  }

  if (scoped) lines.push(...scopingSection(scoped));

  lines.push('## Output', '```', output.substring(0, 5000), '```');
  return lines.join('\n');
}

function runAffectedSuite({ envVar, stepName, reportFile, label, timeout, scopeSpecs }) {
  return (state, ctx) => {
    const cmd = process.env[envVar];
    if (!cmd) return null; // not configured → skip

    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;
    const reportPath = path.join(reportFolder, reportFile);

    // Scoped CHANGED_SPECS + per-spec budget for the e2e suite (echo-5224):
    // strictly-changed spec files (plus importers of changed helpers), so the
    // repo's reliability sweep can't drag in unchanged siblings.
    const scoped = scopeSpecs ? computeChangedSpecs() : null;
    const extraEnv = scopeSpecs ? buildE2eEnv(scoped) : undefined;

    const result = runCommand(cmd, timeout, extraEnv);
    const analysis = classifyRun(result);
    const outcome = analysis.result; // PASSED | FAILED | CRASHED
    const status = outcome === 'PASSED' ? 'APPROVED' : 'NEEDS_WORK';

    writeReportAtomic(
      reportPath,
      buildReport({
        status,
        outcome,
        label,
        envVar,
        exitCode: result.exitCode,
        analysis,
        output: result.output,
        scoped,
      })
    );

    if (status !== 'APPROVED') {
      state.testsFailed = true;
      const reason =
        outcome === 'CRASHED'
          ? `${label} test runner CRASHED (infrastructure failure, not test failures): "${analysis.crashSignature}".`
          : `${label} tests failed (${analysis.counts.failed ?? '?'} failing).`;
      return {
        type: 'check_instruction',
        action: 'failed',
        state: { ticket: state.ticketId, currentStep: stepName },
        reason,
        report: reportPath,
      };
    }

    return null;
  };
}

module.exports = { runAffectedSuite };
