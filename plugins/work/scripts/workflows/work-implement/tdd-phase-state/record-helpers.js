'use strict';

/**
 * tdd-phase-state/record-helpers.js
 *
 * Shared helpers for the record-* subcommands, extracted from
 * tdd-phase-state.js (GH-610 static-quality refactor). Each helper preserves
 * the exact error strings, exit semantics, and guard behavior of the original
 * inline code.
 */

const { execSync } = require('child_process');
const { isTestFile } = require('../tdd-phase-registry');
const { parseCmd, safeParseTask, errorExit, parseTestSummary } = require('./io');
const { readState } = require('./state-path');
const { isDocsExemptAllowed } = require('./active-task');

/**
 * Parse the common `--cmd` + `--task` preamble shared by the record commands.
 * Errors on a missing ticket ID or missing `--cmd`. Returns `{ cmd, taskNum,
 * opts }`. (record-green resolves these in a different order for its citation
 * short-circuit, so it does not use this helper.)
 */
function parseRecordArgs(ticketId, args) {
  if (!ticketId) errorExit('Missing ticket ID.');
  const cmd = parseCmd(args);
  if (!cmd) errorExit('Missing --cmd argument.');
  const taskNum = safeParseTask(args);
  const opts = taskNum ? { taskNum } : undefined;
  return { cmd, taskNum, opts };
}

/**
 * Parse a required `--reason` for a bypass subcommand. When absent/empty, write
 * the caller's `BYPASS:` recovery line to stderr and exit 1 (fail-closed, no
 * audit). Otherwise return the reason string.
 */
function parseBypassReason(args, bypassLine) {
  const reasonIdx = args.indexOf('--reason');
  const reason = reasonIdx !== -1 && reasonIdx + 1 < args.length ? args[reasonIdx + 1] : undefined;
  if (!reason || !reason.trim()) {
    process.stderr.write(bypassLine);
    process.exit(1);
  }
  return reason;
}

/** Read phase state or fail with the canonical "run init first" message. */
function requireState(ticketId, opts) {
  const state = readState(ticketId, opts);
  if (!state) errorExit('No TDD phase state found. Run "init" first.');
  return state;
}

/**
 * Enforce that the current phase matches the phase being recorded. Mirrors the
 * original per-command guard message exactly.
 * @param {object} state
 * @param {'red'|'green'|'refactor'} phase - required currentPhase
 * @param {'RED'|'GREEN'|'REFACTOR'} label - upper-case evidence label
 * @param {'red'|'green'|'refactor'} target - lower-case "transition to" target
 */
function assertRecordPhase(state, phase, label, target) {
  if (state.currentPhase !== phase) {
    errorExit(
      `Cannot record ${label} evidence: current phase is "${state.currentPhase}". Transition to ${target} first.`
    );
  }
}

/**
 * Detect changed/staged/untracked test files via git. Returns the subset that
 * are test files. Fail-open to [] when git is unavailable or not a repo.
 */
function detectChangedTestFiles() {
  let allChanged = [];
  try {
    const diff = execSync('git diff --name-only', { encoding: 'utf8' }).trim();
    const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
    const untracked = execSync('git ls-files --others --exclude-standard', {
      encoding: 'utf8',
    }).trim();
    allChanged = [
      ...new Set(
        [...diff.split('\n'), ...staged.split('\n'), ...untracked.split('\n')].filter(Boolean)
      ),
    ];
  } catch {
    // git not available or not a repo
  }
  return allChanged.filter((f) => isTestFile(f));
}

/**
 * Resolve the `--docs-exempt` opt-in for a record command. Returns false when
 * not requested; errors with the operator-facing reason when requested but the
 * active task's Type/scope does not allow it; true when allowed.
 */
function resolveDocsExempt(ticketId, taskNum, args) {
  if (!(Array.isArray(args) && args.includes('--docs-exempt'))) return false;
  const check = isDocsExemptAllowed(ticketId, taskNum);
  if (!check.allowed) errorExit(check.reason);
  return true;
}

/** True when a test runner produced no stdout AND no stderr (RC-D trap). */
function isEmptyTestOutput(stdout, stderr) {
  return stdout.trim() === '' && stderr.trim() === '';
}

/**
 * RC-B defense: reject all-skipped false positives. A spec where every test is
 * `.skip` exits 0 but delivers zero coverage. `phaseWord` is GREEN / REFACTOR.
 */
function rejectAllSkipped(stdout, stderr, phaseWord) {
  const summary = parseTestSummary(stdout + '\n' + stderr);
  if (summary.parsed && summary.passed === 0 && summary.skipped > 0) {
    errorExit(
      'All tests are skipped (' +
        summary.skipped +
        ' skipped, 0 passed). ' +
        phaseWord +
        ' requires actual passing tests, not skipped. ' +
        "Unskip the affected tests in this PR's scope, or document the skips with " +
        'their follow-up tickets in tasks.md before re-invoking me.'
    );
  }
}

module.exports = {
  parseRecordArgs,
  parseBypassReason,
  requireState,
  assertRecordPhase,
  detectChangedTestFiles,
  resolveDocsExempt,
  isEmptyTestOutput,
  rejectAllSkipped,
};
