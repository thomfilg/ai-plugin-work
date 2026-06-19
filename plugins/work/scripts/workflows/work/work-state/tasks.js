/**
 * Task-progress + task-review fix-round tracking. Extracted verbatim from
 * work-state.js (file-size burndown) — behavior unchanged; state IO comes
 * from ./core.
 */

'use strict';

const { loadState, saveState } = require('./core');

/**
 * Load state + tasksMeta for a ticket. Returns `{ error }` when no task
 * tracking exists, otherwise `{ state, meta, idx }` where `idx` is the current
 * task pointer (may be past the end — callers decide how to treat overflow).
 */
function loadTasksMeta(ticketId) {
  const state = loadState(ticketId);
  if (!state?.tasksMeta) return { error: 'No task tracking initialized' };
  const meta = state.tasksMeta;
  return { state, meta, idx: meta.currentTaskIndex };
}

/**
 * Like loadTasksMeta, but treats a past-the-end pointer as an error — used by
 * the fix-round helpers, which require a live current task.
 */
function resolveCurrentTask(ticketId) {
  const resolved = loadTasksMeta(ticketId);
  if (resolved.error) return resolved;
  if (resolved.idx >= resolved.meta.tasks.length) {
    return { error: 'All tasks completed, no current task' };
  }
  return resolved;
}

/**
 * Get the current task info.
 */
function getTaskCurrent(ticketId) {
  const resolved = loadTasksMeta(ticketId);
  if (resolved.error) return resolved;
  const { meta, idx } = resolved;
  if (idx >= meta.tasks.length) return { done: true, message: 'All tasks completed' };

  return {
    id: meta.tasks[idx].id,
    index: idx,
    status: meta.tasks[idx].status,
    total: meta.totalTasks,
  };
}

/**
 * Advance to the next task. Marks current as completed, moves pointer.
 * Returns the next task info or { done: true } if all tasks are complete.
 */
function advanceTask(ticketId) {
  const resolved = loadTasksMeta(ticketId);
  if (resolved.error) return resolved;
  const { state, meta, idx } = resolved;

  // Already past the end — idempotent return
  if (idx >= meta.tasks.length) {
    return { done: true, message: 'All tasks already completed' };
  }

  // Mark current task as completed
  if (idx < meta.tasks.length) {
    meta.tasks[idx].status = 'completed';
  }

  // Advance pointer
  meta.currentTaskIndex = idx + 1;

  // GH-211: Reset fix-round counter on the NEW task so each task starts fresh
  if (meta.currentTaskIndex < meta.tasks.length) {
    meta.tasks[meta.currentTaskIndex].taskReviewFixRounds = 0;
  }

  saveState(ticketId, state);

  if (meta.currentTaskIndex >= meta.tasks.length) {
    return { done: true, message: 'All tasks completed', completedTask: idx }; // terminal — all tasks done
  }
  // Normal advance — mark current completed, move to next
  return {
    done: false,
    completedTask: idx,
    nextTask: {
      id: meta.tasks[meta.currentTaskIndex].id,
      index: meta.currentTaskIndex,
      status: meta.tasks[meta.currentTaskIndex].status,
      total: meta.totalTasks,
    },
  };
}

/**
 * Get the current fix-round count for the current task.
 * Returns 0 when the field is absent (new task).
 * Also returns maxFixRounds and whether max is reached.
 */
function getTaskReviewFixRounds(ticketId) {
  const resolved = resolveCurrentTask(ticketId);
  if (resolved.error) return resolved;
  const { meta, idx } = resolved;

  const fixRounds = meta.tasks[idx].taskReviewFixRounds || 0;
  const parsed = parseInt(process.env.TASK_REVIEW_MAX_FIXES, 10);
  const maxFixRounds = Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;

  // Task review fix-round status — consumed by task-review step for escalation decisions
  return {
    fixRounds,
    maxFixRounds,
    maxReached: fixRounds >= maxFixRounds, // true when no more fix attempts allowed
    taskIndex: idx,
    taskId: meta.tasks[idx].id,
  };
}

/**
 * Increment the fix-round counter for the current task by 1 and persist.
 */
function incrementTaskReviewFixRounds(ticketId) {
  const resolved = resolveCurrentTask(ticketId);
  if (resolved.error) return resolved;
  const { state, meta, idx } = resolved;

  const current = meta.tasks[idx].taskReviewFixRounds || 0;
  meta.tasks[idx].taskReviewFixRounds = current + 1;

  saveState(ticketId, state);

  return {
    fixRounds: meta.tasks[idx].taskReviewFixRounds,
    taskIndex: idx,
    taskId: meta.tasks[idx].id,
  };
}

/**
 * Reset the fix-round counter for the current task to 0 and persist.
 */
function resetTaskReviewFixRounds(ticketId) {
  const resolved = resolveCurrentTask(ticketId);
  if (resolved.error) return resolved;
  const { state, meta, idx } = resolved;

  meta.tasks[idx].taskReviewFixRounds = 0;

  saveState(ticketId, state);

  return {
    fixRounds: 0,
    taskIndex: idx,
    taskId: meta.tasks[idx].id,
  };
}

/**
 * Get a specific task by index.
 */
function getTaskByIndex(ticketId, taskIndex) {
  const state = loadState(ticketId);
  if (!state?.tasksMeta) return { error: 'No task tracking initialized' };

  const idx = parseInt(taskIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= state.tasksMeta.tasks.length) {
    return {
      error: `Invalid task index: ${taskIndex}. Valid range: 0-${state.tasksMeta.tasks.length - 1}`,
    };
  }

  return {
    id: state.tasksMeta.tasks[idx].id,
    index: idx,
    status: state.tasksMeta.tasks[idx].status,
    total: state.tasksMeta.totalTasks,
  };
}

module.exports = {
  getTaskCurrent,
  advanceTask,
  getTaskReviewFixRounds,
  incrementTaskReviewFixRounds,
  resetTaskReviewFixRounds,
  getTaskByIndex,
};
