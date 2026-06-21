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

/** Keys that scope a retry-failure block to a specific task. */
const RETRY_KEYS = [
  '_tddRetryReason',
  '_tddRetryCount',
  '_tddRetryCommand',
  '_tddRetryExitCode',
  '_tddRetryOutputTail',
  '_tddRetryTask',
];

/** Delete all per-task retry state from the work-state object. */
function clearRetryState(ws) {
  for (const k of RETRY_KEYS) delete ws[k];
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

/** Update tasks.md checkboxes; fail-open. */
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
 * Dispatch-advance gate for the implement step.
 *
 * @param {string} safeName - Sanitized ticket ID
 * @param {object} ctx - Context from work-next.js
 * @param {object} deps - Dependencies injected from work-next.js
 * @returns {null | { recurse: true }} - null=no action (re-dispatch), recurse=re-run orchestrator
 */
function dispatchAdvanceGate(safeName, ctx, deps) {
  const { loadWorkState, saveWorkState, readTddEvidence, validateTddEvidence, stepName } = deps;

  const ws = loadWorkState(safeName);
  if (!ws?.tasksMeta || !Array.isArray(ws.tasksMeta.tasks)) {
    return null;
  }

  // Reconcile tasksMeta with tasks.md before reading currentIdx/totalTasks.
  reconcileTasksMetaWithFile(ws, ctx && ctx.tasksDir, saveWorkState, safeName, deps.log);

  const currentIdx = ws.tasksMeta.currentTaskIndex ?? 0;
  const totalTasks = ws.tasksMeta.tasks.length;
  const taskNum = currentIdx + 1; // 1-indexed

  if (handleAllTasksDone(ws, currentIdx, totalTasks, saveWorkState, safeName)) {
    return null;
  }

  // Helper: persist retry-failure context so the next dispatch prompt can
  // surface the exact command, exit code, and output to the agent.
  const recordRetry = (reason, extras) => {
    ws._tddRetryReason = reason;
    ws._tddRetryCount = (ws._tddRetryCount || 0) + 1;
    ws._tddRetryCommand = extras?.command || null;
    ws._tddRetryExitCode = extras?.exitCode ?? null;
    ws._tddRetryOutputTail = extras?.outputTail || '';
    ws._tddRetryTask = taskNum;
    saveWorkState(safeName, ws);
  };

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
    validateTddEvidence,
    tddEnforcement,
    readTddEvidence,
    stepName,
  };

  const flow = runNonCheckpointFlow(state);
  if (flow.handled) return null;

  // Evidence valid — clear retry state.
  clearRetryState(ws);
  saveWorkState(safeName, ws);

  return advanceValidatedTask(safeName, ctx, deps, currentIdx, totalTasks);
}

module.exports = { dispatchAdvanceGate };
