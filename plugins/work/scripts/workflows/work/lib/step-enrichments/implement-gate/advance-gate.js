/**
 * Dispatch-advance gate for the implement step.
 *
 * Handles task-advance when the current task's TDD evidence is valid and more
 * tasks remain: advances the task pointer (and the checkpoint fast-path),
 * delegating the per-task RED/GREEN evidence flow to `evidence-flow.js`.
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const { markProgress } = require(path.join(__dirname, '..', '..', 'mark-task-progress'));
const { resolveTaskType } = require(path.join(__dirname, '..', '..', 'resolve-task-type'));

const { reconcileTasksMetaWithFile } = require(path.join(__dirname, 'reconcile'));
const { runNonCheckpointFlow } = require(path.join(__dirname, 'evidence-flow'));
// W3 — planner-defect operator-hold (retry-state keys live there too).
const {
  clearRetryState,
  persistRetryFailure,
  buildPlannerHoldInstruction,
  resolvePlannerHold,
} = require(path.join(__dirname, 'planner-hold'));

/**
 * GH-755 shadow mode: when WORK_TDD_MODE=shadow, log the outcome verifier's
 * verdict for this boundary alongside the incumbent gate outcome. Zero
 * authority, never throws, lazily loaded so the hot path pays nothing when
 * the flag is off.
 *
 * repoDir is intentionally NOT passed: the /work orchestrator's contract is
 * cwd == the ticket worktree (the same assumption every gate git call makes),
 * and the repo path is NOT derivable from ctx.tasksDir — tasks dirs live
 * under TASKS_BASE, worktrees under WORKTREES_BASE. A wrong-cwd invocation
 * degrades to an audited task-verify-shadow-error row, never a wrong verdict
 * with authority (shadow has none).
 */
function runShadowObserver(safeName, ctx, taskNum, taskType, incumbent) {
  if (process.env.WORK_TDD_MODE !== 'shadow') return;
  try {
    const { maybeRunShadow } = require(
      path.join(__dirname, '..', '..', '..', '..', 'task-verify', 'shadow')
    );
    maybeRunShadow({ safeName, tasksDir: ctx && ctx.tasksDir, taskNum, taskType, incumbent });
  } catch {
    /* shadow must never affect the gate */
  }
}

/** Derive TASKS_BASE + a subprocess env from ctx.tasksDir. */
function deriveGateExecEnv(ctx) {
  const gateTASKS_BASE = ctx.tasksDir ? path.dirname(ctx.tasksDir) : process.env.TASKS_BASE;
  const env = gateTASKS_BASE ? { ...process.env, TASKS_BASE: gateTASKS_BASE } : process.env;
  return env;
}

/** Run `work-state.js task-advance` for the ticket; fail-open. */
function runTaskAdvance(workDir, safeName, gateExecEnv) {
  execFileSync(process.execPath, [path.join(workDir, 'work-state.js'), 'task-advance', safeName], {
    encoding: 'utf-8',
    timeout: 5000,
    stdio: 'pipe',
    env: gateExecEnv,
  });
}

/** Clear dispatch markers so the next gate pass dispatches a fresh task. */
function clearDispatchMarkers(loadWorkState, saveWorkState, safeName) {
  const ws2 = loadWorkState(safeName);
  if (ws2) {
    delete ws2._work2Dispatched;
    delete ws2._work2DispatchedAction;
    delete ws2._preTestForTask;
    saveWorkState(safeName, ws2);
  }
}

/** Tick completed-task checkboxes in the plan file; fail-open. */
function safeMarkProgress(tasksDir) {
  if (!tasksDir) return;
  try {
    markProgress(tasksDir);
  } catch {
    /* fail-open */
  }
}

/**
 * Out-of-bounds guard: when all tasks are done, clear any stale retry/pre-test
 * state and stop. Returns true when the caller must return null.
 */
function handleAllTasksDone(ws, currentIdx, totalTasks, saveWorkState, safeName) {
  if (currentIdx < totalTasks) return false;
  if (ws._tddRetryReason || ws._tddRetryCount || ws._preTestForTask) {
    clearRetryState(ws);
    delete ws._preTestForTask;
    saveWorkState(safeName, ws);
  }
  return true;
}

/**
 * Advance immediately for a checkpoint task (exempt from TDD evidence).
 * Returns null (last task) or { recurse: true } (more tasks remain).
 */
function advanceCheckpointTask(safeName, ctx, deps, currentIdx, totalTasks) {
  const { loadWorkState, saveWorkState, workDir, log, recursionDepth } = deps;
  const gateExecEnv = deriveGateExecEnv(ctx);
  try {
    runTaskAdvance(workDir, safeName, gateExecEnv);
  } catch {
    /* fail-open — surfaced via completeWork's terminal guard if it really failed */
  }
  // Clear dispatch markers so the next pass dispatches fresh (mirrors the
  // non-last-task branch below).
  clearDispatchMarkers(loadWorkState, saveWorkState, safeName);
  safeMarkProgress(ctx.tasksDir);
  if (log) {
    log.recurse(recursionDepth, `checkpoint advance ${currentIdx + 1} (skipped TDD evidence)`);
  }
  // If checkpoint was the last task, return null so work-next.js can
  // transition implement → commit. Otherwise return recurse.
  if (currentIdx >= totalTasks - 1) return null;
  return { recurse: true };
}

/**
 * Evidence is valid — advance the task pointer. For non-last tasks, advance and
 * recurse; for the last task, record completion bookkeeping and return null.
 */
function advanceValidatedTask(safeName, ctx, deps, currentIdx, totalTasks) {
  const { loadWorkState, saveWorkState, workDir, log, recursionDepth } = deps;
  const gateExecEnv = deriveGateExecEnv(ctx);

  if (currentIdx < totalTasks - 1) {
    try {
      runTaskAdvance(workDir, safeName, gateExecEnv);
      clearDispatchMarkers(loadWorkState, saveWorkState, safeName);
      safeMarkProgress(ctx.tasksDir);
      if (log) {
        log.recurse(recursionDepth, `task-advance ${currentIdx + 1} → ${currentIdx + 2}`);
      }
      return { recurse: true };
    } catch {
      return null;
    }
  }

  // All tasks done with valid evidence — mark last task completed and update
  // checkboxes. task-advance only runs for non-last tasks above, so the last
  // task would otherwise stay status !== 'completed' and block the complete step.
  try {
    runTaskAdvance(workDir, safeName, gateExecEnv);
  } catch {
    /* fail-open — task-advance returns { done: true } for last task, which is fine */
  }
  safeMarkProgress(ctx.tasksDir);
  return null;
}

/**
 * Load work state, reconcile tasksMeta with tasks.md, and bounds-check the
 * task pointer. Returns null when the gate has nothing to do (no tasksMeta,
 * or all tasks already done), else `{ ws, currentIdx, totalTasks, taskNum }`.
 */
function prepareGateTasks(safeName, ctx, deps) {
  const { loadWorkState, saveWorkState } = deps;

  const ws = loadWorkState(safeName);
  if (!ws?.tasksMeta || !Array.isArray(ws.tasksMeta.tasks)) {
    return null;
  }

  // Reconcile tasksMeta with tasks.md before reading currentIdx/totalTasks.
  reconcileTasksMetaWithFile(ws, ctx && ctx.tasksDir, saveWorkState, safeName, deps.log);

  const currentIdx = ws.tasksMeta.currentTaskIndex ?? 0;
  const totalTasks = ws.tasksMeta.tasks.length;

  if (handleAllTasksDone(ws, currentIdx, totalTasks, saveWorkState, safeName)) {
    return null;
  }

  return { ws, currentIdx, totalTasks, taskNum: currentIdx + 1 }; // 1-indexed
}

/**
 * Dispatch-advance gate for the implement step.
 *
 * @param {string} safeName - Sanitized ticket ID
 * @param {object} ctx - Context from work-next.js
 * @param {object} deps - Dependencies injected from work-next.js
 * @returns {null | { recurse: true } | object} - null=no action (re-dispatch),
 *   recurse=re-run orchestrator, object=full instruction (W3 operator-hold)
 */
function dispatchAdvanceGate(safeName, ctx, deps) {
  const { saveWorkState, readTddEvidence, stepName } = deps;

  const prepared = prepareGateTasks(safeName, ctx, deps);
  if (!prepared) return null;
  const { ws, currentIdx, totalTasks, taskNum } = prepared;

  // W3 — an unresolved planner defect holds for the operator BEFORE any test
  // re-runs or re-dispatch; the hold auto-clears (and normal flow resumes)
  // once the defective task's tasks.md section hash changes.
  const held = resolvePlannerHold({ ws, ctx, saveWorkState, safeName });
  if (held) return held;

  // Persist retry-failure context (planner-hold.js persistRetryFailure) so
  // the next dispatch prompt — or the W3 operator-hold — can surface the
  // exact command, exit code, and output.
  const tasksDir = ctx && ctx.tasksDir ? ctx.tasksDir : null;
  const recordRetry = (reason, extras) =>
    persistRetryFailure({ ws, taskNum, tasksDir, saveWorkState, safeName }, reason, extras);

  // Check task type BEFORE evidence — checkpoint tasks are exempt from TDD.
  const taskType = resolveTaskType(ctx.tasksDir, taskNum);
  if (taskType === 'checkpoint') {
    return advanceCheckpointTask(safeName, ctx, deps, currentIdx, totalTasks);
  }

  const gateTasksBase = ctx.tasksDir ? path.dirname(ctx.tasksDir) : null;
  const tddEnforcement = require(
    path.join(__dirname, '..', '..', '..', '..', 'work', 'lib', 'tdd-enforcement')
  );

  const state = {
    ws,
    ctx,
    safeName,
    taskNum,
    taskType,
    gateTasksBase,
    recordRetry,
    saveWorkState,
    tddEnforcement,
    readTddEvidence,
    stepName,
  };

  const flow = runNonCheckpointFlow(state);
  if (flow.handled) {
    runShadowObserver(safeName, ctx, taskNum, taskType, 'blocked');
    // W3 — a planner-defect retry recorded on THIS pass must not fall back to
    // null (work-next.js would re-dispatch a developer agent at a defect it
    // cannot fix). Emit the operator-hold immediately — no retry burn.
    if (ws._tddRetryPlannerDefect) return buildPlannerHoldInstruction(ws, safeName);
    return null;
  }

  runShadowObserver(safeName, ctx, taskNum, taskType, 'advance');

  // Evidence valid — clear retry state.
  clearRetryState(ws);
  saveWorkState(safeName, ws);

  return advanceValidatedTask(safeName, ctx, deps, currentIdx, totalTasks);
}

module.exports = { dispatchAdvanceGate };
