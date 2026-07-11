'use strict';

/**
 * tdd-phase-state/gate-writer.js
 *
 * W11 — the ONE evidence writer for the implement GATE. The gate previously
 * raw-`writeFileSync`ed tdd-phase.json from `test-runner.js`/`evidence.js`,
 * bypassing every recorder-side trap: atomic tmp+rename writes, the RED
 * load-failure heuristic (GH-532's bug stayed alive on the gate path), the
 * hang rejection (GH-584 / W5), and shape consistency. All gate writes now
 * flow through this module:
 *
 *   - writeGateRed:   hang rejection → load-failure rejection → atomic write
 *   - writeGateGreen: hang rejection → RC-D empty-output rejection (per the
 *                     shared gateContractFor(taskType).rcdEmptyTrap flag) →
 *                     atomic write of prebuilt evidence
 *   - writeGateStub:  atomic write of a skip/non-TDD stub; the WORK_SKIP_E2E
 *                     stub additionally appends a `tdd-e2e-skip-stub` audit
 *                     row so the fabricated cycle is visible in
 *                     `.work-actions.json`.
 *
 * TOKEN GATE — deliberate non-integration: gate writes do NOT route through
 * `token.js`. The implement gate runs in the trusted orchestrator context
 * (work-next.js), not in an agent shell; the token gate exists to stop
 * AGENTS from calling the tdd-phase-state CLI outside the sanctioned
 * task-next flow. Routing the orchestrator through it would add a bypass
 * env var to the gate path for zero enforcement value.
 *
 * Rejections return `{ rejected: true, reason, ... }` for the gate to turn
 * into a retry / operator-hold; they never `process.exit` (this module is
 * require()d in-process by the gate, unlike the recorder CLI).
 */

const path = require('path');

const { writeStateAtomic } = require('./state-path');
const { formatTestTimeout } = require('./io');
// GH-532 — same RED load-failure heuristic the recorder applies.
const { detectRedLoadFailure, extractLoadFailureSnippet } = require('../lib/red-load-failure');
// RC-D — same empty-output trap the recorder applies (record-cycle.js
// GREEN_EMPTY_MSG), armed per-Type by the SAME gateContractFor().rcdEmptyTrap
// flag the recorder's --docs-exempt path honors (active-task.js).
const { isEmptyTestOutput } = require('./record-helpers');
// GH-694 — the recorder's exact tests-only "declared test files actually
// changed" rule (GH-528), shared via the extracted module so the gate and
// task-next.js can never drift (unification invariant).
const { detectChangedTestFilesInScope } = require('../lib/changed-test-files');
const { gateContractFor } = require(
  path.join(__dirname, '..', '..', '..', '..', 'skills', 'split-in-tasks', 'lib', 'task-types')
);

/** Best-effort enforcement audit row scoped to the gate's own tasks base. */
function appendGateAudit(tasksBase, ticketId, entry) {
  try {
    const { appendEnforcementAuditAt } = require('../../work/lib/work-actions');
    appendEnforcementAuditAt(tasksBase, ticketId, entry);
  } catch {
    /* fail-open on audit write — the gate decision is the source of truth */
  }
}

/**
 * W5 §4 + W3 message policy — hang rejection shared by the gate's pre- and
 * post-implement paths. A timed-out run is a HANG, not a test outcome: the
 * killed process's non-zero exit must never record as RED, and it can never
 * legitimately record as GREEN. Appends a `tdd-<phase>-hang-rejected` audit
 * row and returns the planner-defect rejection the gate turns into an
 * operator-hold retry.
 *
 * @param {object} p - { tasksBase, ticketId, taskNum, phase, cmd, timeoutMs }
 * @returns {{ rejected: true, kind: 'hang', plannerDefect: true, reason: string }}
 */
function gateHangRejection(p) {
  appendGateAudit(p.tasksBase, p.ticketId, {
    origin: 'workflow',
    task: p.taskNum || null,
    phase: p.phase,
    action: `tdd-${p.phase}-hang-rejected`,
    allow: false,
    reason: 'test-command-timeout',
    outputPath: null,
    meta: { testCommand: p.cmd, timeoutMs: p.timeoutMs, capturedByGate: true },
  });
  const label = formatTestTimeout(p.timeoutMs);
  return {
    rejected: true,
    kind: 'hang',
    plannerDefect: true,
    reason:
      `Test command for task ${p.taskNum} timed out (${label}) at the gate. ` +
      'A hang is not a test outcome — the command must run to completion. ' +
      'This usually means a watch-mode or interactive command in the ' +
      '`### Test Strategy` block, which is a planner defect. tasks.md is ' +
      'planner-owned and LOCKED during implement — do NOT edit it. STOP and ' +
      'report `BLOCKED (planner-defect): test command hangs ' +
      '(watch-mode/interactive)` back to the orchestrator.',
  };
}

/** Load-failure rejection: audit row + agent-actionable reason (fix the test file). */
function gateLoadFailureRejection(p, loadFailure) {
  appendGateAudit(p.tasksBase, p.ticketId, {
    origin: 'workflow',
    task: p.taskNum || null,
    phase: 'red',
    action: 'tdd-red-load-failure-rejected',
    allow: false,
    reason: loadFailure.signature,
    outputPath: null,
    meta: {
      testCommand: p.cmd,
      signature: loadFailure.signature,
      snippet: extractLoadFailureSnippet(loadFailure.line),
      capturedByGate: true,
    },
  });
  return {
    rejected: true,
    kind: 'load-failure',
    reason:
      `Rejected RED at the gate: detected ${loadFailure.signature} in the test ` +
      'runner output. The test file is structurally broken (load-time error or ' +
      'zero tests collected), not a behavior gap — this exact crash would repeat ' +
      'regardless of source edits and wedge GREEN. Fix the test file so it loads ' +
      'and fails on assertions; the gate re-runs the command on the next pass.',
  };
}

/**
 * Write authentic gate-captured RED evidence, applying the recorder's traps
 * first: hang rejection (W5/GH-584), then the RED load-failure heuristic
 * (GH-532). On success writes atomically and stamps `capturedByGate: true`.
 *
 * @param {object} p
 * @param {string} p.tasksBase   gate-derived tasks base (audit rows)
 * @param {string} p.ticketId    sanitized ticket id
 * @param {number} p.taskNum
 * @param {string} p.evidencePath absolute tdd-phase.json path
 * @param {string} p.cmd
 * @param {number} p.exitCode    non-zero exit of the failing run
 * @param {string} p.output      combined stdout+stderr
 * @param {boolean} [p.timedOut]
 * @param {number} [p.timeoutMs]
 * @param {string} p.now         ISO timestamp
 * @param {{logPath: string, logBytes: number}|null} [p.redLog]
 * @returns {{ written: true } | { rejected: true, kind: string, reason: string, plannerDefect?: true }}
 */
function writeGateRed(p) {
  if (p.timedOut) {
    return gateHangRejection({ ...p, phase: 'red' });
  }
  const loadFailure = detectRedLoadFailure({ stdout: String(p.output || ''), stderr: '' });
  if (loadFailure.matched) {
    return gateLoadFailureRejection(p, loadFailure);
  }
  const evidence = {
    currentPhase: 'red',
    currentCycle: 1,
    cycles: [
      {
        cycle: 1,
        red: {
          testFiles: [],
          testCommand: p.cmd,
          testExitCode: p.exitCode,
          timestamp: p.now,
          capturedByGate: true,
          outputTail: String(p.output).slice(-2000),
          ...(p.redLog ? { logPath: p.redLog.logPath, logBytes: p.redLog.logBytes } : {}),
        },
      },
    ],
  };
  writeStateAtomic(p.evidencePath, evidence);
  return { written: true };
}

/**
 * RC-D rejection at the gate: an exit-0 run with zero stdout+stderr proves
 * nothing (the recorder refuses the identical run via GREEN_EMPTY_MSG).
 * Re-running a silent-success command is always empty again, so this is a
 * planner defect (noisy command needed) — W3 policy: never suggest editing
 * tasks.md. Audited as `tdd-green-empty-rejected` so the refusal is visible.
 */
function gateEmptyOutputRejection(p) {
  appendGateAudit(p.tasksBase, p.ticketId, {
    origin: 'workflow',
    task: p.taskNum || null,
    phase: 'green',
    action: 'tdd-green-empty-rejected',
    allow: false,
    reason: 'empty-output-exit-0',
    outputPath: null,
    meta: { testCommand: p.cmd, taskType: p.taskType || null, capturedByGate: true },
  });
  return {
    rejected: true,
    kind: 'empty-output',
    plannerDefect: true,
    reason:
      `GREEN for task ${p.taskNum} exited 0 with NO stdout/stderr output at ` +
      'the gate. Real test runs always emit output — this is the RC-D ' +
      'empty-output trap the recorder applies to the identical run. A ' +
      'command that is legitimately silent on success (e.g. a bare grep ' +
      'verifier) can never satisfy this check — the `### Test Strategy` ' +
      'needs a noisy command that emits output on success. That is a ' +
      'planner defect: tasks.md is planner-owned and LOCKED during ' +
      'implement — do NOT edit it. STOP and report `BLOCKED ' +
      '(planner-defect): silent-success test command` back to the ' +
      'orchestrator.',
  };
}

/**
 * GH-694 rejection: a Type=tests-only GREEN whose in-scope test files are all
 * byte-identical to HEAD proves nothing — the GH-689 gate recorded GREEN by
 * re-running an untouched pre-existing suite while the task's actual
 * deliverable never existed. NOT a planner defect: the rejection flows into
 * the existing dispatch-retry and the developer fixes it by writing the
 * declared tests. Audited as `tdd-green-tests-only-unchanged-rejected`.
 */
function gateTestsOnlyUnchangedRejection(p) {
  appendGateAudit(p.tasksBase, p.ticketId, {
    origin: 'workflow',
    task: p.taskNum || null,
    phase: 'green',
    action: 'tdd-green-tests-only-unchanged-rejected',
    allow: false,
    reason: 'tests-only-no-changed-test-files',
    outputPath: null,
    meta: { testCommand: p.cmd, taskType: p.taskType || null, capturedByGate: true },
  });
  return {
    rejected: true,
    kind: 'tests-only-unchanged',
    reason:
      'Type=tests-only GREEN requires at least one declared in-scope ' +
      '*.test.* / *.spec.* file modified vs HEAD — running an unchanged ' +
      `pre-existing suite is not evidence (task ${p.taskNum}). Write the ` +
      'tests the task declares, then re-run. Note: committing the test ' +
      'files mid-implement also empties this diff (detection is vs HEAD, ' +
      'recorder parity per GH-528).',
  };
}

/**
 * Atomically persist prebuilt GREEN-augmented evidence (built by the gate's
 * `buildGreenEvidence`). Defensively rejects a timed-out run — a hang is not
 * a pass — mirroring the recorder-side W5 policy. Applies the recorder's
 * RC-D empty-output trap (GH-466 suggested fix #1) per the task's Type
 * contract: `gateContractFor(taskType).rcdEmptyTrap === false` kinds (docs /
 * config / ci / file-move / checkpoint — the recorder's docs-exempt
 * equivalents) stay exempt; everything else (tdd-code, tests-only,
 * mechanical-refactor, unknown → fail closed) refuses a zero-output exit-0
 * GREEN instead of recording it.
 *
 * GH-694: tests-only GREENs additionally require a changed in-scope test
 * file (the recorder's GH-528 rule, via the SAME shared function). On
 * success the changed set is stamped as `green.testsOnlyChangedFiles`
 * (audit-only field — validateTddEvidenceForType deliberately does NOT
 * check it, so pre-change gate evidence keeps validating).
 *
 * @param {object} p - { tasksBase, ticketId, taskNum, evidencePath, evidence,
 *                       cmd, output?, taskType?, workingDir?, scope?,
 *                       timedOut?, timeoutMs? }
 * @returns {{ written: true } | { rejected: true, kind: 'hang'|'empty-output'|'tests-only-unchanged', reason: string, plannerDefect?: true }}
 */
function writeGateGreen(p) {
  if (p.timedOut) {
    return gateHangRejection({ ...p, phase: 'green' });
  }
  const contract = gateContractFor(p.taskType);
  if (contract.rcdEmptyTrap && isEmptyTestOutput(String(p.output ?? ''), '')) {
    return gateEmptyOutputRejection(p);
  }
  if (contract.kind === 'tests-only') {
    const changedTestFiles = detectChangedTestFilesInScope(p.workingDir, p.scope);
    if (changedTestFiles.length === 0) {
      return gateTestsOnlyUnchangedRejection(p);
    }
    const greenCycle = Array.isArray(p.evidence?.cycles)
      ? p.evidence.cycles.find((c) => c && c.green)
      : null;
    if (greenCycle) greenCycle.green.testsOnlyChangedFiles = changedTestFiles;
  }
  writeStateAtomic(p.evidencePath, p.evidence);
  return { written: true };
}

/** Build the WORK_SKIP_E2E full-cycle stub (red+green share the stub entry). */
function buildSkipStub(p) {
  const stub = {
    testCommand: p.cmd,
    testExitCode: 0,
    timestamp: p.now,
    capturedByGate: true,
    skippedByGate: true,
    note: `Test execution skipped by gate (reason: ${p.reason}).`,
  };
  return {
    currentPhase: 'refactor',
    currentCycle: 1,
    cycles: [{ cycle: 1, red: { ...stub }, green: { ...stub } }],
  };
}

/** Build the non-TDD pre-test stub (red-only; task type does not require TDD). */
function buildNonTddStub(p) {
  return {
    currentPhase: 'green',
    currentCycle: 1,
    cycles: [
      {
        cycle: 1,
        red: {
          testCommand: p.cmd,
          testExitCode: 0,
          timestamp: p.now,
          capturedByGate: true,
          note: `RED skipped: task type "${p.taskType}" does not require TDD.`,
        },
      },
    ],
  };
}

/**
 * Write a stub evidence file via the shared atomic writer.
 *
 * @param {object} p
 * @param {'e2e-skip'|'non-tdd-pre-test'} p.stubKind
 * @param {string} p.tasksBase / p.ticketId / p.evidencePath / p.cmd / p.now
 * @param {string} [p.reason]   skip reason (e2e-skip)
 * @param {string} [p.taskType] declared Type (non-tdd-pre-test)
 * @param {number} [p.taskNum]
 * @returns {{ written: true }}
 *
 * The `e2e-skip` stub records a FABRICATED complete cycle by operator env
 * choice (WORK_SKIP_E2E=1). It is audit-logged as `tdd-e2e-skip-stub` so the
 * fabrication is visible in `.work-actions.json` rather than silent.
 */
function writeGateStub(p) {
  const isSkip = p.stubKind === 'e2e-skip';
  const evidence = isSkip ? buildSkipStub(p) : buildNonTddStub(p);
  writeStateAtomic(p.evidencePath, evidence);
  if (isSkip) {
    appendGateAudit(p.tasksBase, p.ticketId, {
      origin: 'workflow',
      task: p.taskNum || null,
      phase: null,
      action: 'tdd-e2e-skip-stub',
      allow: true,
      reason: p.reason,
      outputPath: path.relative(path.join(p.tasksBase, p.ticketId), p.evidencePath),
      meta: { testCommand: p.cmd, capturedByGate: true, skippedByGate: true },
    });
  }
  return { written: true };
}

module.exports = {
  writeGateRed,
  writeGateGreen,
  writeGateStub,
  gateHangRejection,
};
