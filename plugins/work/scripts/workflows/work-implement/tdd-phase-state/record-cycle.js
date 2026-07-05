'use strict';

/**
 * tdd-phase-state/record-cycle.js
 *
 * The init / current / record-green / record-refactor / transition subcommands
 * extracted from tdd-phase-state.js (GH-610 static-quality refactor). Guard
 * order, error strings, RC-D/RC-B defenses, citation-green short-circuit, and
 * recorded evidence shapes are preserved byte-for-byte.
 */

const {
  parseCmd,
  safeParseTask,
  runTestCommandWithOutput,
  formatTestTimeout,
  getCurrentCycleRecord,
  errorExit,
  successOut,
} = require('./io');
const { writeState } = require('./state-path');
const { tddCanTransition } = require('../tdd-phase-registry');
const {
  testStrategyLib,
  CITATION_KINDS,
  resolveActiveTaskStrategy,
  recordCitationEvidence,
} = require('./strategy');
const {
  parseRecordArgs,
  requireState,
  assertRecordPhase,
  resolveDocsExempt,
  isEmptyTestOutput,
  rejectAllSkipped,
} = require('./record-helpers');
// GH-570 — ablation-GREEN revert verification + audit row.
const { recordAblationGreen } = require('./ablation');

// RC-D empty-command-trap messages. GREEN names the specific env vars,
// REFACTOR uses the generic phrasing — matching the originals. Both carry the
// silent-verifier resolution (W2.4, APPSUPEN-1239): a command that is
// legitimately silent on success (e.g. a bare `grep` verifier on a
// mechanical-refactor task) can NEVER satisfy this trap — the Test Strategy
// needs a noisy command (one that emits output on success). tasks.md is
// planner-owned and LOCKED during implement, so that is a planner defect to
// report, not something the agent may edit around.
const SILENT_VERIFIER_RESOLUTION =
  ' If the command is legitimately silent on success (e.g. a bare grep ' +
  'verifier), it can never satisfy this check — the Test Strategy needs a ' +
  'noisy command that emits output on success. That is a planner defect: ' +
  'STOP and report `BLOCKED (planner-defect): silent-success test command` ' +
  'to the orchestrator. Do NOT edit tasks.md.';

const GREEN_EMPTY_MSG =
  'GREEN test command exited 0 with NO stdout/stderr output. This is the ' +
  'empty-command trap (typically an unbound test-command env var expanded ' +
  'to `eval ""`). Real test runs always emit output. Source the worktree' +
  "'s .envrc so $TEST_UNIT_COMMAND / $TEST_INTEGRATION_COMMAND are bound, " +
  'verify the command runs real tests, then retry.' +
  SILENT_VERIFIER_RESOLUTION;

const REFACTOR_EMPTY_MSG =
  'REFACTOR test command exited 0 with NO stdout/stderr output. This is the ' +
  'empty-command trap (typically an unbound test-command env var expanded ' +
  'to `eval ""`). Real test runs always emit output. Source the worktree' +
  "'s .envrc so test-command env vars are bound, verify the command runs " +
  'real tests, then retry.' +
  SILENT_VERIFIER_RESOLUTION;

/**
 * GH-584 — a hang is not a passing run either. Name the hang explicitly
 * instead of emitting the generic "Tests failed (exit N)" message the killed
 * run's non-zero exit would otherwise produce. Neutral on cause: at GREEN /
 * REFACTOR the hang may be an implementation bug (infinite loop) rather than
 * a planner defect, so no planner-defect verdict here.
 */
function formatHangDiagnostic(phaseLabel, timeoutMs) {
  return (
    `${phaseLabel} test command timed out (${formatTestTimeout(timeoutMs)}) and was killed. ` +
    'A hang is not a passing run — the command must run to completion and ' +
    'exit 0. Check for an infinite loop in the implementation or a ' +
    'watch-mode/interactive command, fix the cause, then retry.'
  );
}

function cmdInit(ticketId, args) {
  if (!ticketId) {
    errorExit('Missing ticket ID. Usage: node tdd-phase-state.js init <TICKET_ID>');
  }
  const taskNum = safeParseTask(args || []);
  const opts = taskNum ? { taskNum } : undefined;
  const state = {
    currentPhase: 'red',
    currentCycle: 1,
    cycles: [],
  };
  writeState(ticketId, state, opts);
  successOut({ ok: true, phase: 'red', cycle: 1 });
}

function cmdCurrent(ticketId, args) {
  if (!ticketId) {
    errorExit('Missing ticket ID.');
  }
  const taskNum = safeParseTask(args || []);
  const opts = taskNum ? { taskNum } : undefined;
  const state = requireState(ticketId, opts);
  successOut({ phase: state.currentPhase, cycle: state.currentCycle });
}

/**
 * GH-610 Task 2 — citation-kind GREEN short-circuit. For `verified-by` /
 * `wiring-citation` strategies there is no `--cmd`; validate the peer pointer
 * and record evidence by citation. Returns true when handled (caller returns).
 */
function tryRecordCitationGreen(ticketId, cmd, taskNum, opts) {
  if (cmd) return false;
  if (!testStrategyLib || typeof testStrategyLib.validatePeerCitation !== 'function') return false;
  const resolved = resolveActiveTaskStrategy(ticketId, taskNum);
  if (!resolved || !CITATION_KINDS.has(resolved.strategy.kind)) return false;
  const state = requireState(ticketId, opts);
  assertRecordPhase(state, 'green', 'GREEN', 'green');
  recordCitationEvidence(ticketId, state, resolved, opts);
  return true;
}

/**
 * GH-570 — dispatch to the ablation-GREEN recorder when this cycle's RED
 * evidence carries `ablation: true`. Returns true when handled (caller
 * returns); false routes to the standard GREEN write.
 */
function _maybeRecordAblationGreen(params) {
  if (!params.record.red || params.record.red.ablation !== true) return false;
  recordAblationGreen(params);
  return true;
}

function cmdRecordGreen(ticketId, args) {
  if (!ticketId) errorExit('Missing ticket ID.');
  const taskNum = safeParseTask(args);
  const opts = taskNum ? { taskNum } : undefined;

  // Citation path must short-circuit BEFORE the `--cmd` requirement (citation
  // callers pass no `--cmd`). Envelope / custom kinds fall through unchanged.
  const cmd = parseCmd(args);
  if (tryRecordCitationGreen(ticketId, cmd, taskNum, opts)) return;
  if (!cmd) errorExit('Missing --cmd argument.');

  const docsExempt = resolveDocsExempt(ticketId, taskNum, args);

  const state = requireState(ticketId, opts);
  assertRecordPhase(state, 'green', 'GREEN', 'green');

  const { exitCode, stdout, stderr, timedOut, timeoutMs } = runTestCommandWithOutput(cmd);
  // GH-584: reject hangs BEFORE the exit-code check so the killed run is
  // named as a hang rather than a generic failure.
  if (timedOut) {
    errorExit(formatHangDiagnostic('GREEN', timeoutMs));
  }
  if (exitCode !== 0) {
    errorExit('Tests must PASS in GREEN phase. Tests failed (exit ' + exitCode + ').');
  }

  // RC-D defense: refuse the "empty command exits 0" trap (armed for
  // non-docs-exempt tasks).
  if (!docsExempt && isEmptyTestOutput(stdout, stderr)) {
    errorExit(GREEN_EMPTY_MSG);
  }

  // RC-B defense: reject all-skipped false positives.
  rejectAllSkipped(stdout, stderr, 'GREEN');

  const record = getCurrentCycleRecord(state);

  // GH-570 — ablation-GREEN: when this cycle's RED evidence was recorded via
  // the ablation path, verify the source mutation was reverted, stamp
  // revertSha, and append the tdd-ablation-cycle audit row (both shas).
  if (_maybeRecordAblationGreen({ ticketId, state, record, cmd, exitCode, taskNum, opts })) {
    return;
  }

  record.green = {
    testCommand: cmd,
    testExitCode: exitCode,
    timestamp: new Date().toISOString(),
  };
  writeState(ticketId, state, opts);
  successOut({ ok: true, phase: 'green', cycle: state.currentCycle, testExitCode: exitCode });
}

// cmdRecordRefactor: records re-run evidence only; does NOT invoke
// /tests-review or /code-review. Those reviewer commands run as a separate
// post-commit gate owned by workflows/work/steps/task-review.js (GH-211).
function cmdRecordRefactor(ticketId, args) {
  const { cmd, taskNum, opts } = parseRecordArgs(ticketId, args);

  const state = requireState(ticketId, opts);
  assertRecordPhase(state, 'refactor', 'REFACTOR', 'refactor');

  // Mirror the GREEN `--docs-exempt` opt-in on REFACTOR.
  const docsExempt = resolveDocsExempt(ticketId, taskNum, args);

  const { exitCode, stdout, stderr, timedOut, timeoutMs } = runTestCommandWithOutput(cmd);
  // GH-584: same hang rejection as GREEN.
  if (timedOut) {
    errorExit(formatHangDiagnostic('REFACTOR', timeoutMs));
  }
  if (exitCode !== 0) {
    errorExit('Tests must still PASS after refactoring. Tests failed (exit ' + exitCode + ').');
  }

  // RC-D defense: same empty-command guard as GREEN.
  if (!docsExempt && isEmptyTestOutput(stdout, stderr)) {
    errorExit(REFACTOR_EMPTY_MSG);
  }

  // RC-B defense: same all-skipped guard as GREEN.
  rejectAllSkipped(stdout, stderr, 'REFACTOR');

  const record = getCurrentCycleRecord(state);
  record.refactor = {
    testCommand: cmd,
    testExitCode: exitCode,
    timestamp: new Date().toISOString(),
  };
  writeState(ticketId, state, opts);
  successOut({ ok: true, phase: 'refactor', cycle: state.currentCycle, testExitCode: exitCode });
}

function cmdTransition(ticketId, targetPhase, args) {
  if (!ticketId) errorExit('Missing ticket ID.');
  if (!targetPhase) errorExit('Missing target phase.');
  const taskNum = safeParseTask(args || []);
  const opts = taskNum ? { taskNum } : undefined;

  const state = requireState(ticketId, opts);

  // Validate transition
  if (!tddCanTransition(state.currentPhase, targetPhase)) {
    errorExit(
      `Invalid transition: ${state.currentPhase} -> ${targetPhase}. ` +
        `Valid transitions: red->green, green->refactor, green->red, refactor->red.`
    );
  }

  // Validate evidence exists for current phase
  const currentCycleRecord = state.cycles.find((c) => c.cycle === state.currentCycle);
  if (!currentCycleRecord || !currentCycleRecord[state.currentPhase]) {
    errorExit(
      `No evidence recorded for ${state.currentPhase} phase. ` +
        `Run "record-${state.currentPhase}" first.`
    );
  }

  // Update phase
  state.currentPhase = targetPhase;

  // If transitioning refactor -> red, increment cycle
  if (targetPhase === 'red') {
    state.currentCycle += 1;
  }

  writeState(ticketId, state, opts);
  successOut({ phase: state.currentPhase, cycle: state.currentCycle });
}

module.exports = {
  cmdInit,
  cmdCurrent,
  cmdRecordGreen,
  cmdRecordRefactor,
  cmdTransition,
};
