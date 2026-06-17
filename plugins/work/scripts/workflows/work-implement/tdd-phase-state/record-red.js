'use strict';

/**
 * tdd-phase-state/record-red.js
 *
 * RED-family subcommands (record-red, record-red --synthesized, record-skip-red)
 * extracted from tdd-phase-state.js (GH-610 static-quality refactor). All guard
 * order, error strings, BYPASS/exit semantics, audit rows, and recorded
 * evidence shapes are preserved byte-for-byte.
 */

const {
  safeParseTask,
  runTestCommand,
  runTestCommandWithOutput,
  getCurrentCycleRecord,
  errorExit,
  successOut,
} = require('./io');
const { writeState } = require('./state-path');
const { readActiveTaskType, taskTypes } = require('./active-task');
const {
  parseRecordArgs,
  parseBypassReason,
  requireState,
  assertRecordPhase,
  detectChangedTestFiles,
  resolveDocsExempt,
} = require('./record-helpers');
// GH-532 — RED load-failure heuristic.
const { detectRedLoadFailure, extractLoadFailureSnippet } = require('../lib/red-load-failure');

/**
 * Resolve the `--red-skip-file-guard` opt-in. Returns false when not requested;
 * errors when requested but the active task's contract does not waive the file
 * guard; true when allowed. Mirrors the original cross-check against
 * gateContractFor(type).redRequiresTestFiles.
 */
function resolveRedSkipFileGuard(ticketId, taskNum, args) {
  if (!(Array.isArray(args) && args.includes('--red-skip-file-guard'))) return false;
  const declaredType = readActiveTaskType(ticketId, taskNum);
  let allowed = false;
  if (declaredType && taskTypes && typeof taskTypes.gateContractFor === 'function') {
    const contract = taskTypes.gateContractFor(declaredType);
    allowed = !!(contract && contract.redRequiresTestFiles === false);
  }
  if (!allowed) {
    errorExit(
      '--red-skip-file-guard is restricted to Types whose contract sets ' +
        'redRequiresTestFiles=false (tests-only / docs / config / ci / ' +
        'mechanical-refactor / file-move / checkpoint). ' +
        `Task ${taskNum || '?'} has Type="${declaredType || 'unknown'}", ` +
        'which still requires a *.test.* file modification at RED. ' +
        'Author a failing test, or fix the `### Type` line in tasks.md.'
    );
  }
  return true;
}

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

function cmdRecordRed(ticketId, args) {
  const { cmd, taskNum, opts } = parseRecordArgs(ticketId, args);

  // Spec §P0#4 — synthesized-cycle bypass.
  if (args.includes('--synthesized')) {
    return cmdRecordRedSynthesized(ticketId, args, cmd, taskNum, opts);
  }

  const state = requireState(ticketId, opts); // reads per-task path when taskNum provided
  assertRecordPhase(state, 'red', 'RED', 'red');

  const testFiles = detectChangedTestFiles();
  const docsExempt = resolveDocsExempt(ticketId, taskNum, args);
  const redSkipFileGuard = resolveRedSkipFileGuard(ticketId, taskNum, args);
  if (testFiles.length === 0 && !docsExempt && !redSkipFileGuard) {
    errorExit('No test files changed. RED phase requires modified .test or .spec files.');
  }

  // Run tests — they must FAIL
  const { exitCode, stdout, stderr } = runTestCommandWithOutput(cmd);
  if (exitCode === 0) {
    errorExit('Tests must FAIL in RED phase. Tests passed (exit 0).');
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

  const record = getCurrentCycleRecord(state);
  record.red = {
    testFiles,
    testCommand: cmd,
    testExitCode: exitCode,
    timestamp: new Date().toISOString(),
  };
  writeState(ticketId, state, opts);
  successOut({
    ok: true,
    phase: 'red',
    cycle: state.currentCycle,
    testFiles,
    testExitCode: exitCode,
  });
}

/**
 * Handle `record-red --synthesized --reason "<...>"` (spec §P0#4).
 *
 * Mirrors the structure of `cmdException` so the two bypass paths share
 * auditing semantics. Empty/missing reason → BYPASS line + exit 1, no audit.
 */
function cmdRecordRedSynthesized(ticketId, args, cmd, taskNum, opts) {
  // Empty/missing reason → BYPASS line + exit 1, no audit (fail-closed).
  const reason = parseBypassReason(
    args,
    'BYPASS: tdd-phase-state.js record-red --synthesized --reason "<why this cycle is synthesized>"\n'
  );

  const state = requireState(ticketId, opts);
  assertRecordPhase(state, 'red', 'RED', 'red');

  // The bypass requires a *passing* command (exit 0): the agent claims the
  // failing test already exists/is covered, so re-running it must pass.
  const exitCode = runTestCommand(cmd);
  if (exitCode !== 0) {
    errorExit(
      '--synthesized requires the supplied --cmd to exit 0 (the pre-existing test should pass). ' +
        'Command exited ' +
        exitCode +
        '.'
    );
  }

  const testFiles = detectChangedTestFiles();

  const record = getCurrentCycleRecord(state);
  record.red = {
    testFiles,
    testCommand: cmd,
    testExitCode: exitCode,
    synthesized: true,
    reason: reason,
    timestamp: new Date().toISOString(),
  };

  // Transition RED → GREEN as part of the bypass.
  state.currentPhase = 'green';
  writeState(ticketId, state, opts);

  // Append the audit row via the canonical writer (R11).
  try {
    const { appendEnforcementAudit } = require('../../work/lib/work-actions');
    appendEnforcementAudit(ticketId, {
      origin: 'ai-subtask',
      task: taskNum || null,
      phase: 'red',
      action: 'tdd-synthesized-cycle',
      allow: true,
      reason: reason,
      outputPath: null,
      meta: { cycle: state.currentCycle, testCommand: cmd },
    });
  } catch {
    /* fail-open on audit write — the state transition is the source of truth */
  }

  successOut({
    ok: true,
    phase: 'green',
    cycle: state.currentCycle,
    synthesized: true,
    reason,
    testExitCode: exitCode,
  });
}

/**
 * record-skip-red — tests-only Type RED-skipped contract (GH-528 item 4).
 *
 * Persists `cycle.red = { skipped: true, reason, timestamp }` and transitions
 * RED → GREEN. Requires --reason (empty → BYPASS line) and Type=tests-only.
 */
function cmdRecordSkipRed(ticketId, args) {
  if (!ticketId) errorExit('Missing ticket ID.');
  const taskNum = safeParseTask(args);
  const opts = taskNum ? { taskNum } : undefined;

  const reason = parseBypassReason(
    args,
    'BYPASS: tdd-phase-state.js record-skip-red --reason "<why RED is intentionally skipped>"\n'
  );

  const state = requireState(ticketId, opts);
  if (state.currentPhase !== 'red') {
    errorExit(
      'Cannot record skip-red: current phase is "' +
        state.currentPhase +
        '". record-skip-red only valid during red phase.'
    );
  }

  // GH-528 round-2 follow-up (Cursor[bot] HIGH): Type=tests-only gate. Read the
  // Type from on-disk tasks.md and require it to be exactly `tests-only`.
  const declaredType = readActiveTaskType(ticketId, taskNum);
  if (declaredType !== 'tests-only') {
    errorExit(
      'record-skip-red is restricted to Type=tests-only tasks. ' +
        `Task ${taskNum || '?'} has Type="${declaredType || 'unknown'}". ` +
        'If this task is genuinely tests-only, fix the `### Type` line in tasks.md ' +
        '(only the planner may author Type values — see split-in-tasks/lib/task-types.js). ' +
        'Otherwise run record-red with a real failing test.'
    );
  }

  const record = getCurrentCycleRecord(state);
  record.red = {
    skipped: true,
    reason,
    timestamp: new Date().toISOString(),
  };
  state.currentPhase = 'green';
  writeState(ticketId, state, opts);
  successOut({ ok: true, phase: 'green', cycle: state.currentCycle, skipped: true, reason });
}

module.exports = {
  cmdRecordRed,
  cmdRecordRedSynthesized,
  cmdRecordSkipRed,
};
