/**
 * Step: 4_run_tests — Run automated tests inline (deterministic). Failures
 * return blocked so work-next.js transitions back to implement.
 * Runner priority: 0 SCRIPT_RUN_AFFECTED_* (affected-only, fastest) →
 * 1 $LINT/$TYPECHECK/$TEST_COMMAND via dev-check.sh → 2 pnpm dev:check →
 * 3 bundled dev-check.sh → 4 pnpm test / node --test.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { writeReportAtomic } = require('../report-utils');
const { classifyRun, shouldRetry } = require('../test-run-analysis');
const { readBaseline, writeBaseline, splitFailures } = require('../tests-baseline');
const {
  computeChangedSpecs,
  buildE2eEnv,
  computeImpactTests,
  buildUnitEnv,
} = require('../changed-specs');
// Allowlist sanitizer every env-derived command line passes before the shell.
const { safeEnvCommand } = require('../safe-env-command');
// Typecheck-error delta vs per-ticket baseline (echo-5137-issue-4).
const typecheckBaseline = require('../typecheck-baseline');

function runCommand(cmd, timeout, env) {
  try {
    const output = execSync(`${cmd} 2>&1`, {
      encoding: 'utf8',
      timeout,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return { output, exitCode: 0 };
  } catch (err) {
    return {
      output: (err.stdout || '') + (err.stderr || ''),
      exitCode: err.status || 1,
    };
  }
}

/**
 * Lazy per-suite env resolver (computed at most once per suite kind):
 * - e2e: scoped CHANGED_SPECS + per-spec budget — strictly-changed spec files
 *   plus importers of changed helpers (echo-5224).
 * - unit: impact-aware selection (echo-5820-3): IMPACT_TEST_FILES = test files
 *   importing a changed source file (one hop). CHECK_IMPACT_TESTS=0 disables.
 */
function createSuiteEnvResolver(outputs) {
  const cache = {};
  return function envForSuite(name) {
    if (name in cache) return cache[name];
    if (name === 'e2e') {
      cache.e2e = buildE2eEnv(computeChangedSpecs());
    } else if (name === 'unit') {
      const impact = computeImpactTests();
      cache.unit = buildUnitEnv(impact) || undefined;
      if (cache.unit) {
        outputs.push(
          `### impact-aware selection: +${impact.impactTests.length} test file(s) importing changed sources (IMPACT_TEST_FILES, base ${impact.baseRef})`
        );
      }
    } else {
      cache[name] = undefined;
    }
    return cache[name];
  };
}

// Tier 0 (preferred): per-suite SCRIPT_RUN_AFFECTED_* env vars, run in
// sequence; the first non-zero exit short-circuits. Null when unconfigured.
function runAffectedSuites() {
  const suites = [
    { name: 'unit', cmd: safeEnvCommand(process.env.SCRIPT_RUN_AFFECTED_UNIT) },
    { name: 'integration', cmd: safeEnvCommand(process.env.SCRIPT_RUN_AFFECTED_INTEGRATION) },
    { name: 'e2e', cmd: safeEnvCommand(process.env.SCRIPT_RUN_AFFECTED_E2E) },
  ].filter((s) => s.cmd);

  if (suites.length === 0) return null;

  const outputs = [];
  const envForSuite = createSuiteEnvResolver(outputs);
  for (const { name, cmd } of suites) {
    const suiteEnv = envForSuite(name);
    outputs.push(`### ${name} (${cmd})`);
    const result = runCommand(cmd, 600000, suiteEnv);
    outputs.push(result.output);
    if (result.exitCode !== 0) {
      return {
        output: outputs.join('\n'),
        exitCode: result.exitCode,
        tier: `affected-${name} (failed)`,
      };
    }
  }
  return {
    output: outputs.join('\n'),
    exitCode: 0,
    tier: `affected (${suites.map((s) => s.name).join('+')})`,
  };
}

// Tier 2: pnpm dev:check (project-defined). Returns a result, or null when the
// repo has no package.json or no dev:check script.
function tryPnpmDevCheck() {
  try {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    if (pkg.scripts && pkg.scripts['dev:check']) {
      return { ...runCommand('pnpm dev:check', 120000), tier: 'pnpm dev:check' };
    }
  } catch {
    /* no package.json */
  }
  return null;
}

/**
 * Tiers 1-4 (fallback when no affected-suite env vars are set):
 * 1: $LINT/$TYPECHECK/$TEST_COMMAND via bundled dev-check.sh (evaluated with
 * $CHANGED_FILES); 2: pnpm dev:check; 3: bundled dev-check.sh; 4: pnpm test.
 */
function runDevCheckTiers(checkHooksDir) {
  const devCheckScript = path.join(
    checkHooksDir,
    '..',
    '..',
    'scripts',
    'dev-check',
    'dev-check.sh'
  );

  // Tier 1: env-var overrides — dev-check.sh already honors LINT_COMMAND /
  // TYPECHECK_COMMAND / TEST_COMMAND, so routing through it lets repos override
  // every step via .envrc without touching package.json.
  const envOverridesPresent =
    process.env.LINT_COMMAND || process.env.TYPECHECK_COMMAND || process.env.TEST_COMMAND;
  if (envOverridesPresent && fs.existsSync(devCheckScript)) {
    return {
      ...runCommand(`bash "${devCheckScript}"`, 120000),
      tier: 'dev-check.sh ($LINT/$TYPECHECK/$TEST_COMMAND)',
    };
  }

  const pnpmResult = tryPnpmDevCheck();
  if (pnpmResult) return pnpmResult;

  // Tier 3: bundled dev-check script
  if (fs.existsSync(devCheckScript)) {
    return { ...runCommand(`bash "${devCheckScript}"`, 120000), tier: 'dev-check.sh' };
  }

  // Tier 4: pnpm test or node --test
  return { ...runCommand('pnpm test || node --test', 120000), tier: 'pnpm test' };
}

/**
 * Run quality gate and return { output, exitCode, tier }. Tier 0
 * (affected-suite env vars) wins when configured; otherwise fall back through
 * the dev-check tiers.
 */
function runQualityGate(checkHooksDir) {
  return runAffectedSuites() || runDevCheckTiers(checkHooksDir);
}

// --- tests.check.md report sections (GH-394) --------------------------------
// Result, Crash Signature, Flaky-passed list, Net-new vs pre-existing,
// Typecheck Delta, Output, Verdict. The first line after Changes Hash is the
// canonical machine-readable `**Status:**` line — gates parse it FIRST.

function crashSection(analysis) {
  return [
    '## Crash Signature',
    '',
    'The test RUNNER crashed — this is an infrastructure failure, not a test failure.',
    `> "${analysis.crashSignature}"`,
    '',
  ];
}

function flakySection(flakyTests, retryNote) {
  const trigger = retryNote ? ` (retry trigger — ${retryNote})` : '';
  const items =
    flakyTests.length > 0
      ? flakyTests.map((t) => `- ${t}`)
      : ['- (failing tests could not be itemized from runner output)'];
  return [
    '## Flaky (passed on retry)',
    '',
    `The following failed on the first run and passed on the single retry round${trigger}:`,
    ...items,
    '',
  ];
}

function deltaList(title, entries) {
  const items = entries.length > 0 ? entries.map((t) => `- ${t}`) : ['- none'];
  return [`### ${title} (${entries.length})`, ...items];
}

function baselineSection({ baseline, delta, outcome }) {
  const lines = ['## Baseline', ''];
  if (!baseline) {
    lines.push(
      'Baseline unavailable — no `tests-baseline.json`; all failures treated as blocking (same as before).'
    );
  } else {
    lines.push(
      `**Baseline:** ${baseline.ref || 'unknown ref'} (recorded ${baseline.recordedAt}, ${baseline.failures.length} known failure(s))`
    );
    if (delta && (outcome === 'FAILED' || outcome === 'CRASHED')) {
      lines.push('', ...deltaList('Net-new failures', delta.netNew));
      lines.push('', ...deltaList('Pre-existing failures', delta.preExisting));
    }
  }
  lines.push('');
  return lines;
}

function verdictLine({ status, outcome, analysis, flakyTests, typecheck }) {
  const tcNote =
    typecheck && typecheck.netNew.length > 0
      ? ` BUT typecheck regressed (${typecheck.netNew.length} net-new error(s) — see Typecheck Delta)`
      : '';
  const byOutcome = Object.create(null);
  byOutcome.PASSED = `**${status}** - All tests pass${tcNote}`;
  byOutcome.FLAKY = `**${status}** - Tests pass (with warning: ${flakyTests.length || 'some'} flaky test(s) passed only on retry — see Flaky section)${tcNote}`;
  byOutcome.CRASHED = `**${status}** - Test runner CRASHED (infra failure, not test failures)`;
  return byOutcome[outcome] || `**${status}** - ${analysis.counts.failed ?? '?'} test(s) failing`;
}

function buildTestsReport(input) {
  const { changesHash, status, outcome, result, analysis, flakyTests, retryNote } = input;

  const lines = [
    `**Changes Hash:** ${changesHash}`,
    '',
    `**Status:** ${status}`,
    '',
    '# Test Results Report',
    '',
    `**Result:** ${outcome}`,
    `**Runner:** ${result.tier}`,
    `**Exit code:** ${result.exitCode}`,
    `**Pass:** ${analysis.counts.passed ?? '?'} | **Fail:** ${analysis.counts.failed ?? '?'}`,
    '',
  ];

  if (outcome === 'CRASHED') lines.push(...crashSection(analysis));

  if (outcome === 'FLAKY') {
    lines.push(...flakySection(flakyTests, retryNote));
  } else if (retryNote) {
    lines.push(`**Flake retry:** attempted (${retryNote}) — still failing after retry.`, '');
  }

  lines.push(...baselineSection(input));
  lines.push(...typecheckBaseline.typecheckSection(input.typecheck));
  lines.push('## Output', '```', result.output.substring(0, 5000), '```', '');
  lines.push('## Verdict', verdictLine(input));

  return lines.join('\n');
}

/**
 * Flake-aware single retry round (echo-4492-001). Only FAILED runs with a
 * small failing set or a transient signature qualify; CRASHED runs are NEVER
 * retried; cap is one round. Returns the (possibly retried) run state.
 */
function applyFlakeRetry(first, firstAnalysis, checkHooksDir) {
  const noRetry = {
    result: first,
    analysis: firstAnalysis,
    outcome: firstAnalysis.result,
    flakyTests: [],
    retryNote: null,
  };
  if (firstAnalysis.result !== 'FAILED') return noRetry;
  const { retry, reason } = shouldRetry(firstAnalysis);
  if (!retry) return noRetry;

  const retryResult = runQualityGate(checkHooksDir);
  const retryAnalysis = classifyRun(retryResult);
  if (retryAnalysis.result === 'PASSED') {
    // Pass with warning — flaky, not red.
    return {
      result: { ...retryResult, tier: `${first.tier} (retried once)` },
      analysis: retryAnalysis,
      outcome: 'FLAKY',
      flakyTests: firstAnalysis.failingTests,
      retryNote: reason,
    };
  }
  // Keep the retry run (fresher evidence); classification may have shifted
  // (e.g. FAILED → CRASHED under memory pressure).
  return {
    result: { ...retryResult, tier: `${first.tier} (retried once, still failing)` },
    analysis: retryAnalysis,
    outcome: retryAnalysis.result,
    flakyTests: [],
    retryNote: reason,
  };
}

function failureReason({ outcome, analysis, delta, baseline }) {
  if (outcome === 'CRASHED') {
    return `Test runner CRASHED (infrastructure failure, not test failures): "${analysis.crashSignature}". Fix the environment or rerun — do NOT treat as failing tests.`;
  }
  if (delta && baseline && delta.netNew.length !== analysis.failingTests.length) {
    return `Tests failed (${analysis.counts.failed ?? '?'} failing; ${delta.netNew.length} net-new vs baseline, ${delta.preExisting.length} pre-existing). Needs fix in implement step.`;
  }
  return `Tests failed (${analysis.counts.failed ?? '?'} failing). Needs fix in implement step.`;
}

// Baseline delta (echo-5137-4): split failures into net-new vs pre-existing;
// refresh on green. Lives in the ticket TASKS dir, NOT the app worktree —
// repo-root writes tripped 7_quality_recheck's git status (PR #669 review).
function assessBaseline(outcome, analysis, baselineDir) {
  const green = outcome === 'PASSED' || outcome === 'FLAKY';
  const baseline = readBaseline(baselineDir);
  const delta =
    outcome === 'FAILED' || outcome === 'CRASHED'
      ? splitFailures(analysis.failingTests, baseline)
      : null;
  if (green) writeBaseline(baselineDir, []);
  return { baseline, delta, status: green ? 'APPROVED' : 'NEEDS_WORK' };
}

function registerRunTests(register) {
  register('4_run_tests', (state, ctx) => {
    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;
    const changesHash = state.changesHash || 'unknown';
    const reportPath = path.join(reportFolder, 'tests.check.md');

    const firstRun = runQualityGate(ctx.checkHooksDir);
    // Flake-aware retry (echo-4492-001): one retry round for small failing
    // sets or transient signatures. CRASHED runs are NEVER retried.
    const { result, analysis, outcome, flakyTests, retryNote } = applyFlakeRetry(
      firstRun,
      classifyRun(firstRun),
      ctx.checkHooksDir
    );

    const { baseline, delta, status } = assessBaseline(outcome, analysis, ctx.tasksDir);

    // Typecheck delta (echo-5137-issue-4): net-new typecheck errors block even
    // when tests pass; pre-existing (inherited) errors are informational only.
    const typecheck = typecheckBaseline.assessTypecheck(ctx.tasksDir, runCommand);
    const finalStatus = typecheck && typecheck.netNew.length > 0 ? 'NEEDS_WORK' : status;

    const report = buildTestsReport({
      changesHash,
      status: finalStatus,
      outcome,
      result,
      analysis,
      flakyTests,
      retryNote,
      baseline,
      delta,
      typecheck,
    });

    // Atomic (tmp + rename) so concurrent readers never see a 0-byte report (GH-611)
    writeReportAtomic(reportPath, report);

    if (finalStatus !== 'APPROVED') {
      state.testsFailed = true;
      const reason =
        status !== 'APPROVED'
          ? failureReason({ outcome, analysis, delta, baseline })
          : typecheckBaseline.typecheckFailureReason(typecheck);
      // Lazy require: registry-derived progress (cycle-safe — the registry
      // itself requires this module at load time).
      const { stepProgress } = require('../step-registry');
      return {
        type: 'check_instruction',
        action: 'failed',
        state: {
          ticket: state.ticketId,
          currentStep: '4_run_tests',
          progress: stepProgress('4_run_tests'),
        },
        reason,
        report: reportPath,
      };
    }

    return null; // auto-advance
  });
}

module.exports = registerRunTests;
module.exports.runQualityGate = runQualityGate;
// Shared single command runner — also used by lib/run-affected-suite.js so the
// whole /check subsystem has one combined-stdout/stderr exec site.
module.exports.runCommand = runCommand;
