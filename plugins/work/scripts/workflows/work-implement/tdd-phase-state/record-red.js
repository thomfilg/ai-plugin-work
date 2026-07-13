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
// Shared RED guard sequence (GH-584 hang + GH-532 load-failure rejections).
const { runGuardedRedCommand } = require('./red-guards');
// GH-570 — ablation-RED mode for regression-coverage tasks.
const {
  ABLATION_RED_MODE,
  SYNTHESIZED_DEPRECATION_WARNING,
  resolveAblationRedMode,
  cmdRecordRedAblation,
} = require('./ablation');

/**
 * GH-570 — route the special RED modes before the standard failing-test
 * path. Returns true when the invocation was fully handled (caller returns):
 * `--synthesized` (deprecated, warned) or a tasks.md-declared ablation task.
 * `resolveAblationRedMode` rejects `--ablation` without the declaration and
 * `--synthesized` WITH it.
 */
function routeSpecialRedModes(ticketId, args, cmd, taskNum, opts) {
  const redMode = resolveAblationRedMode(ticketId, taskNum, args);
  if (args.includes('--synthesized')) {
    process.stderr.write(SYNTHESIZED_DEPRECATION_WARNING);
    cmdRecordRedSynthesized(ticketId, args, cmd, taskNum, opts);
    return true;
  }
  if (redMode === ABLATION_RED_MODE) {
    cmdRecordRedAblation({ ticketId, cmd, taskNum, opts });
    return true;
  }
  return false;
}

/** Block message for a `--red-skip-file-guard` request the contract rejects. */
function redSkipFileGuardError(taskNum, declaredType) {
  const num = taskNum || '?';
  return (
    '--red-skip-file-guard is restricted to Types whose contract sets ' +
    'redRequiresTestFiles=false (tests-only / docs / config / ci / ' +
    'mechanical-refactor / file-move / checkpoint). ' +
    `Task ${num} has Type="${declaredType || 'unknown'}", ` +
    'which still requires a *.test.* file modification at RED. ' +
    'Author a failing test instead. If the `### Type` line is wrong, that ' +
    'is a planner defect: tasks.md is planner-owned and LOCKED during ' +
    'implement — do NOT edit it. STOP and report ' +
    `\`BLOCKED (planner-defect): Type/contract mismatch for task ${num}\` ` +
    'back to the orchestrator.'
  );
}

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
  if (!allowed) errorExit(redSkipFileGuardError(taskNum, declaredType));
  return true;
}

function cmdRecordRed(ticketId, args) {
  const { cmd, taskNum, opts } = parseRecordArgs(ticketId, args);

  // GH-570 — `--synthesized` (deprecated, spec §P0#4) and tasks.md-declared
  // ablation tasks are handled by the routing helper above.
  if (routeSpecialRedModes(ticketId, args, cmd, taskNum, opts)) return;

  const state = requireState(ticketId, opts); // reads per-task path when taskNum provided
  assertRecordPhase(state, 'red', 'RED', 'red');

  const testFiles = detectChangedTestFiles();
  const docsExempt = resolveDocsExempt(ticketId, taskNum, args);
  const redSkipFileGuard = resolveRedSkipFileGuard(ticketId, taskNum, args);
  if (testFiles.length === 0 && !docsExempt && !redSkipFileGuard) {
    errorExit('No test files changed. RED phase requires modified .test or .spec files.');
  }

  // Run tests — they must FAIL. runGuardedRedCommand rejects hangs (GH-584),
  // passing runs, and load-failure fake-REDs (GH-532), in that order.
  const { exitCode } = runGuardedRedCommand({
    ticketId,
    cmd,
    taskNum,
    state,
    passedMsg: 'Tests must FAIL in RED phase. Tests passed (exit 0).',
  });

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
        'If this task is genuinely tests-only, the `### Type` line is a planner ' +
        'defect (only the planner may author Type values — see ' +
        'split-in-tasks/lib/task-types.js): tasks.md is planner-owned and ' +
        'LOCKED during implement — do NOT edit it. STOP and report ' +
        `\`BLOCKED (planner-defect): Type should be tests-only for task ${taskNum || '?'}\` ` +
        'back to the orchestrator. Otherwise run record-red with a real failing test.'
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
