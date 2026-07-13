'use strict';

/**
 * tdd-phase-state/gate-rejections.js
 *
 * The gate writer's rejection builders, extracted VERBATIM from
 * gate-writer.js (file-size burndown — same pattern as the GH-694
 * commit-evidence-gate extraction). Each builder appends its enforcement
 * audit row and returns the `{ rejected: true, kind, reason, ... }` shape
 * the gate turns into a retry / operator-hold; they never `process.exit`.
 *
 * gate-writer.js remains the ONE atomic evidence writer and the module that
 * decides WHEN a rejection fires; this module only owns the audit + message
 * bodies.
 */

const { formatTestTimeout } = require('./io');
const { extractLoadFailureSnippet } = require('../lib/red-load-failure');

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
 * PR #717 rejection: a Type=tests-only GREEN whose `### Files in scope`
 * could not be resolved (unreadable/unparseable tasks.md, or the task block
 * is missing from it) must fail CLOSED — the shared changed-test-files rule
 * treats an empty scope as "any changed test file counts", so degrading a
 * resolution failure to `[]` would let an unrelated test change satisfy the
 * gate. Audited as `tdd-green-tests-only-scope-unresolved-rejected`.
 */
function gateTestsOnlyScopeUnresolvedRejection(p) {
  appendGateAudit(p.tasksBase, p.ticketId, {
    origin: 'workflow',
    task: p.taskNum || null,
    phase: 'green',
    action: 'tdd-green-tests-only-scope-unresolved-rejected',
    allow: false,
    reason: 'tests-only-scope-unresolved',
    outputPath: null,
    meta: {
      testCommand: p.cmd,
      taskType: p.taskType || null,
      capturedByGate: true,
      scopeError: p.scopeError || null,
    },
  });
  return {
    rejected: true,
    kind: 'tests-only-scope-unresolved',
    reason:
      `Type=tests-only GREEN for task ${p.taskNum}: the task's declared ` +
      '`### Files in scope` could not be resolved' +
      (p.scopeError ? ` (${p.scopeError})` : '') +
      ' — failing closed instead of widening to "any changed test file ' +
      'counts". tasks.md is planner-owned and locked during implement: ' +
      'restore a parseable tasks.md containing this task (e.g. `git ' +
      'checkout -- tasks.md` from the plan commit) or STOP and report ' +
      'BLOCKED to the orchestrator, then re-run.',
  };
}

/**
 * GH-690 rejection: a Type=tests-only GREEN whose git change-detection probes
 * FAILED (nonzero/null exit, missing git binary, or the safeSpawnSync 15000ms
 * timeout on a large/slow worktree) must fail CLOSED with an HONEST cause —
 * not the misleading `gateTestsOnlyUnchangedRejection` "you wrote no test"
 * message. Before the safeSpawnSync migration the git probes were unbounded;
 * the enforced 15s timeout added a new way for the changed-set to come back
 * empty, and `detectChangedTestFilesInScope` now throws `GitProbeFailedError`
 * instead of degrading to `[]`. Audited as
 * `tdd-green-tests-only-git-probe-failed-rejected`.
 */
function gateTestsOnlyGitProbeFailedRejection(p) {
  appendGateAudit(p.tasksBase, p.ticketId, {
    origin: 'workflow',
    task: p.taskNum || null,
    phase: 'green',
    action: 'tdd-green-tests-only-git-probe-failed-rejected',
    allow: false,
    reason: 'tests-only-git-probe-failed',
    outputPath: null,
    meta: {
      testCommand: p.cmd,
      taskType: p.taskType || null,
      capturedByGate: true,
      gitProbeError: p.gitProbeError || null,
    },
  });
  return {
    rejected: true,
    kind: 'tests-only-git-probe-failed',
    reason:
      `Type=tests-only GREEN for task ${p.taskNum}: git change detection failed` +
      (p.gitProbeError ? ` (${p.gitProbeError})` : '') +
      ' — could not verify an in-scope test file changed, so the GREEN cannot ' +
      'be recorded (failing closed, not degrading to "no test changed"). This ' +
      'is usually an environment fault (slow/large worktree hitting the 15s ' +
      'probe timeout, or a corrupt/detached repo), not a TDD violation: re-run ' +
      'once the worktree is responsive, or STOP and report to the orchestrator.',
  };
}

module.exports = {
  appendGateAudit,
  gateHangRejection,
  gateLoadFailureRejection,
  gateEmptyOutputRejection,
  gateTestsOnlyUnchangedRejection,
  gateTestsOnlyScopeUnresolvedRejection,
  gateTestsOnlyGitProbeFailedRejection,
};
