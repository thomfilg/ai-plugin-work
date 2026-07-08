/**
 * Reconcile `ws.tasksMeta` against the current tasks.md.
 *
 * When tasks.md is edited mid-workflow (e.g. tasks_gate repair drops a task),
 * `tasksMeta.tasks` keeps the stale entries and the gate then demands TDD
 * evidence for a task that no longer exists. This module truncates the tail to
 * match the file when — AND ONLY WHEN — all dropped entries are still pending.
 */

'use strict';

const path = require('path');

const { parseTasks } = require(path.join(__dirname, '..', '..', 'task-graph'));
const { RETRY_KEYS } = require(path.join(__dirname, 'planner-hold'));

/**
 * Decide whether tasksMeta should be truncated to match tasks.md, returning the
 * new file count when a safe truncation applies, or null when it must not.
 */
function plannedTruncation(ws, tasksDir) {
  if (!tasksDir) return null;
  if (!ws?.tasksMeta || !Array.isArray(ws.tasksMeta.tasks)) return null;

  let parsed;
  try {
    parsed = parseTasks(tasksDir);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const fileCount = parsed.length;
  const stateCount = ws.tasksMeta.tasks.length;
  if (fileCount >= stateCount) return null;

  // Only truncate when EVERY tail entry past fileCount is non-completed.
  // Dropping completed entries would lose evidence of done work.
  const tail = ws.tasksMeta.tasks.slice(fileCount);
  const allTailPending = tail.every((t) => t && t.status !== 'completed');
  if (!allTailPending) return null;

  return { fileCount, stateCount };
}

/** Clear retry/pre-test state that pointed at a now-missing task. */
function clearStaleTaskState(ws, fileCount) {
  if (typeof ws._tddRetryTask === 'number' && ws._tddRetryTask > fileCount) {
    for (const k of RETRY_KEYS) delete ws[k];
  }
  if (ws._preTestForTask !== undefined && ws._preTestForTask !== null) {
    const preTestNum = Number(ws._preTestForTask);
    if (Number.isFinite(preTestNum) && preTestNum > fileCount) {
      delete ws._preTestForTask;
    }
  }
}

/** Emit the reconcile log line, fail-open on any logger error. */
function logReconcile(log, stateCount, fileCount) {
  if (typeof log !== 'function') return;
  try {
    log(
      `tasksMeta reconciled with tasks.md: ${stateCount} → ${fileCount} (dropped ${stateCount - fileCount} pending tail entr${stateCount - fileCount === 1 ? 'y' : 'ies'})`
    );
  } catch {
    /* fail-open */
  }
}

/**
 * Reconcile `ws.tasksMeta` against the current tasks.md.
 * Returns true when state was mutated and saved.
 */
function reconcileTasksMetaWithFile(ws, tasksDir, saveWorkState, safeName, log) {
  const planned = plannedTruncation(ws, tasksDir);
  if (!planned) return false;
  const { fileCount, stateCount } = planned;

  ws.tasksMeta.tasks = ws.tasksMeta.tasks.slice(0, fileCount);
  if (typeof ws.tasksMeta.totalTasks === 'number') {
    ws.tasksMeta.totalTasks = fileCount;
  }
  if ((ws.tasksMeta.currentTaskIndex ?? 0) > fileCount) {
    ws.tasksMeta.currentTaskIndex = fileCount;
  }

  clearStaleTaskState(ws, fileCount);

  try {
    saveWorkState(safeName, ws);
  } catch {
    return false;
  }
  logReconcile(log, stateCount, fileCount);
  return true;
}

module.exports = { reconcileTasksMetaWithFile };
