'use strict';

/**
 * tdd-phase-state/red-guards.js
 *
 * Shared RED-run guard sequence used by the standard RED path
 * (record-red.js) and the GH-570 ablation-RED path (ablation.js):
 *
 *   run command → reject hang (GH-584) → reject exit 0 (caller-specific
 *   message) → reject load-failure fake-RED (GH-532).
 *
 * All error strings, audit rows, and guard ordering are preserved verbatim
 * from record-red.js (GH-610 decomposition lineage) — extracted here so the
 * two callers share one implementation instead of a jscpd clone.
 */

const { runTestCommandWithOutput, formatTestTimeout, errorExit } = require('./io');
// GH-532 — RED load-failure heuristic.
const { detectRedLoadFailure, extractLoadFailureSnippet } = require('../lib/red-load-failure');

/**
 * Build the rejection diagnostic for a RED load-failure. Multi-sentence, names
 * the matched signature. MUST NOT contain a `BYPASS:` line — this is a
 * structural defect, not a justified bypass.
 */
function formatRedLoadFailureDiagnostic(signature) {
  return (
    `Rejected RED: detected ${signature} in test runner output. ` +
    'The test file is structurally broken (load-time error or zero tests collected), ' +
    'not a behavior gap. Fix the test file and re-run ' +
    '`tdd-phase-state.js record-red`.'
  );
}

/**
 * GH-532 Task 2 / R7 / AC10 — append a structured audit row recording the RED
 * load-failure rejection, then call `errorExit` with the diagnostic. Audit
 * append is best-effort; errorExit always fires.
 */
function rejectRedLoadFailure(args) {
  try {
    const { appendEnforcementAudit } = require('../../work/lib/work-actions');
    appendEnforcementAudit(args.ticketId, {
      origin: 'ai-subtask',
      task: args.taskNum || null,
      phase: 'red',
      action: 'tdd-red-load-failure-rejected',
      allow: false,
      reason: args.signature,
      outputPath: null,
      meta: {
        cycle: args.cycle,
        testCommand: args.testCommand,
        signature: args.signature,
        snippet: args.snippet,
      },
    });
  } catch {
    /* fail-open on audit write — rejection still fires below */
  }
  errorExit(formatRedLoadFailureDiagnostic(args.signature));
}

/**
 * GH-584 — rejection diagnostic for a timed-out RED run. A hang is not an
 * assertion failure. Follows the W3 message policy: name the defect, state
 * that tasks.md is planner-owned, instruct the agent to STOP and report a
 * planner defect — never to edit tasks.md.
 */
function formatRedHangDiagnostic(timeoutLabel) {
  return (
    `Rejected RED: test command timed out (${timeoutLabel}). A hang is not an ` +
    'assertion failure — the command must run to completion and fail. This ' +
    'usually means a watch-mode or interactive command in the `### Test ' +
    'Strategy` block, which is a planner defect. tasks.md is planner-owned ' +
    'and LOCKED during implement — do NOT edit it. STOP and report ' +
    '`BLOCKED (planner-defect): test command hangs (watch-mode/interactive)` ' +
    'back to the orchestrator.'
  );
}

/**
 * GH-584 — append a structured audit row recording the RED hang rejection
 * (mirrors `rejectRedLoadFailure` / `tdd-red-load-failure-rejected`), then
 * `errorExit` with the diagnostic. Audit append is best-effort; errorExit
 * always fires.
 */
function rejectRedHang(args) {
  try {
    const { appendEnforcementAudit } = require('../../work/lib/work-actions');
    appendEnforcementAudit(args.ticketId, {
      origin: 'ai-subtask',
      task: args.taskNum || null,
      phase: 'red',
      action: 'tdd-red-hang-rejected',
      allow: false,
      reason: 'test-command-timeout',
      outputPath: null,
      meta: {
        cycle: args.cycle,
        testCommand: args.testCommand,
        timeoutMs: args.timeoutMs,
      },
    });
  } catch {
    /* fail-open on audit write — rejection still fires below */
  }
  errorExit(formatRedHangDiagnostic(formatTestTimeout(args.timeoutMs)));
}

/**
 * Run the RED test command with the full guard sequence. Returns the
 * failing run `{ exitCode, stdout, stderr }` (GH-570: ablation parses the
 * output for best-effort `failingTest` names); every rejection path exits
 * the process.
 *
 * @param {object} p
 * @param {string} p.ticketId
 * @param {string} p.cmd - the test command to execute
 * @param {number|undefined} p.taskNum
 * @param {object} p.state - phase state (currentCycle feeds the audit rows)
 * @param {string} p.passedMsg - caller-specific "command exited 0" rejection
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
function runGuardedRedCommand({ ticketId, cmd, taskNum, state, passedMsg }) {
  const { exitCode, stdout, stderr, timedOut, timeoutMs } = runTestCommandWithOutput(cmd);
  // GH-584: a timed-out run is a hang, not a failing test. Reject BEFORE the
  // exit-code check — the killed run's non-zero exit must never pass as RED.
  if (timedOut) {
    rejectRedHang({ ticketId, cycle: state.currentCycle, testCommand: cmd, taskNum, timeoutMs });
  }
  if (exitCode === 0) {
    errorExit(passedMsg);
  }
  // GH-532: reject fake-RED caused by load failures. Scan stdout and stderr
  // independently — concatenating them can leak an unclosed YAML-envelope
  // state across the seam when stdout is truncated.
  const loadFailure = detectRedLoadFailure({ stdout, stderr });
  if (loadFailure.matched) {
    rejectRedLoadFailure({
      ticketId,
      cycle: state.currentCycle,
      testCommand: cmd,
      signature: loadFailure.signature,
      snippet: extractLoadFailureSnippet(loadFailure.line),
      taskNum,
    });
  }
  return { exitCode, stdout, stderr };
}

module.exports = {
  formatRedLoadFailureDiagnostic,
  rejectRedLoadFailure,
  formatRedHangDiagnostic,
  rejectRedHang,
  runGuardedRedCommand,
};
