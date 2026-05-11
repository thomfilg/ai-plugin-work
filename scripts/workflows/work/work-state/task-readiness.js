'use strict';

/**
 * Task readiness helpers: initTasksMeta, findTaskByNum, canStart, canStartFromState.
 *
 * Extracted from work-state.js (GH-219). Re-exported by ../work-state.js so
 * all existing consumers are unaffected. `findTaskByNum` is intentionally
 * exported for use by both this module and work-state.js directly (e.g. for
 * task status lookups outside the readiness context).
 *
 * Uses lazy require for loadState/saveState/initState to avoid circular
 * dependency with the parent work-state.js module. IMPORTANT: we must NOT
 * destructure at require time — Node returns a partially-constructed exports
 * object during circular resolution. Instead we cache the module reference
 * and access properties at call time.
 */

const { validateTaskGraph } = require('./graph-validation');

// Parent module dependency injection. Set by work-state.js after it finishes
// defining loadState/saveState/initState. This avoids the Node.js circular
// require trap where module.exports replacement makes the cached reference stale.
let _parentFns = null;

/**
 * Inject parent module functions. Called once by work-state.js after its
 * own function definitions are complete.
 */
function _setParent(fns) {
  _parentFns = fns;
}

function parent() {
  if (!_parentFns) {
    // Fallback for direct-require scenarios (e.g. tests that require
    // task-readiness.js after work-state.js is fully loaded).
    _parentFns = require('../work-state');
  }
  return _parentFns;
}

/**
 * Find a persisted task entry by its 1-indexed task number.
 * Returns null if the state is uninitialized or the number is out of range.
 * @param {object} state - Full ticket state as returned by `loadState`.
 * @param {number} taskNum - 1-indexed task number (maps to `task_${N}`).
 * @returns {object|null}
 */
function findTaskByNum(state, taskNum) {
  if (!state || !state.tasksMeta || !Array.isArray(state.tasksMeta.tasks)) return null;
  if (!Number.isInteger(taskNum) || taskNum <= 0) return null;
  const targetId = `task_${taskNum}`;
  return state.tasksMeta.tasks.find((t) => t && t.id === targetId) || null;
}

/**
 * Pure dependency readiness check that operates on already-loaded state.
 *
 * Useful when callers (e.g. preflight, orchestrator) already hold a state
 * object and want to avoid a redundant `loadState` disk read.
 *
 * @param {object} state - Full ticket state as returned by `loadState`.
 * @param {number} taskNum - 1-indexed task number.
 * @returns {boolean}
 */
function canStartFromState(state, taskNum) {
  const task = findTaskByNum(state, taskNum);
  if (!task) return false; // uninitialized, bad input, or unknown task

  // Already completed → not startable (forward-looking query)
  if (task.status === 'completed') return false;

  // R16 backward compat: missing `dependencies` field means the task was
  // persisted under the pre-IDEA2 schema. Treat as empty deps — sequential
  // orchestrator handles ordering.
  if (!Array.isArray(task.dependencies)) return true;

  // Empty deps → startable
  if (task.dependencies.length === 0) return true;

  // All declared deps must resolve to a completed task. Unknown dep →
  // fail-closed (R4: validation should have prevented this, but belt-and-
  // suspenders for state files that skipped the new initTasksMeta path).
  for (const depNum of task.dependencies) {
    const dep = findTaskByNum(state, depNum);
    if (!dep) return false;
    if (dep.status !== 'completed') return false;
  }

  return true;
}

/**
 * Check whether a task is ready to start, per its declared dependencies.
 *
 * Reads state from disk via loadState — reads `loadState(ticketId).tasksMeta` only.
 * Single source of truth for dependency readiness (R3).
 *
 * @param {string} ticketId
 * @param {number} taskNum - 1-indexed task number.
 * @returns {boolean}
 */
function canStart(ticketId, taskNum) {
  const state = parent().loadState(ticketId);
  return canStartFromState(state, taskNum);
}

/**
 * Initialize task tracking for a ticket.
 *
 * Accepts EITHER:
 *   - a positive integer `taskCount` (LEGACY / R16 pre-IDEA2 form) — creates
 *     tasks without a `dependencies` field, matching pre-IDEA2 wire format.
 *   - an array of task descriptors from `parseTasks(tasksDir)` (NEW IDEA2
 *     form) — runs `validateTaskGraph` BEFORE persisting. Invalid graphs
 *     return `{ error, errors }` and never reach disk (R4 fail-closed).
 *
 * Idempotent: if `tasksMeta` already exists, returns it unchanged.
 *
 * @param {string} ticketId
 * @param {number | Array<{num:number, dependencies?:number[]}>} taskCountOrTasks
 * @returns {object}
 */
function initTasksMeta(ticketId, taskCountOrTasks) {
  const { loadState, saveState, initState } = parent();

  // ─── Idempotency check BEFORE validation ──────────────────────────────
  const existingState = loadState(ticketId);
  if (existingState?.tasksMeta) {
    return { success: true, tasksMeta: existingState.tasksMeta, idempotent: true };
  }

  const isTaskArray = Array.isArray(taskCountOrTasks);
  const tasksInput = isTaskArray ? taskCountOrTasks : null;
  const taskCount = isTaskArray ? tasksInput.length : taskCountOrTasks;

  if (!Number.isInteger(taskCount) || taskCount <= 0) {
    return { error: `Invalid taskCount: ${taskCount}. Must be a positive integer.` };
  }

  if (isTaskArray && tasksInput.some((t) => !t || typeof t.num !== 'number')) {
    return { error: 'Invalid tasksInput: each element must have a numeric `num` field.' };
  }

  // ─── Non-contiguous / duplicate task number validation ─────────────────
  if (isTaskArray) {
    const nums = tasksInput.map((t) => t.num);
    const uniqueNums = new Set(nums);
    if (uniqueNums.size !== nums.length) {
      return {
        error: 'Duplicate task numbers detected in tasksInput.',
        errors: [
          {
            code: 'DUPLICATE_TASK_NUMS',
            taskId: null,
            message: 'Duplicate task numbers detected.',
            remediation: ['Each task must have a unique num field.'],
          },
        ],
      };
    }
    const maxNum = Math.max(...nums);
    if (maxNum !== taskCount || !nums.every((n) => n >= 1 && n <= taskCount)) {
      return {
        error: `Task numbers must be contiguous 1..${taskCount}. Found: ${nums.sort((a, b) => a - b).join(', ')}`,
        errors: [
          {
            code: 'NON_CONTIGUOUS_TASK_NUMS',
            taskId: null,
            message: `Task numbers must be contiguous 1..${taskCount}. Found: ${nums.sort((a, b) => a - b).join(', ')}`,
            remediation: ['Ensure tasks are numbered 1 through N with no gaps.'],
          },
        ],
      };
    }
  }

  // ─── R4: Graph validation BEFORE any persistence write ─────────────────
  if (isTaskArray) {
    const validation = validateTaskGraph(tasksInput);
    if (!validation.valid) {
      return {
        error: 'Invalid task graph — see `errors` for details.',
        errors: validation.errors,
      };
    }
  }

  let state = existingState;
  if (!state) state = initState(ticketId);

  // Build a Map for O(1) lookup by task num (avoids O(n²) find-in-loop).
  const taskMap = new Map();
  if (tasksInput) {
    for (const t of tasksInput) {
      if (t && typeof t.num === 'number') taskMap.set(t.num, t);
    }
  }

  const tasks = [];
  for (let i = 0; i < taskCount; i++) {
    const entry = { id: `task_${i + 1}`, status: 'pending' };
    if (isTaskArray) {
      const src = taskMap.get(i + 1);
      const deps =
        src && Array.isArray(src.dependencies)
          ? src.dependencies.filter((d) => Number.isInteger(d))
          : [];
      entry.dependencies = deps.slice(); // defensive copy
    }
    tasks.push(entry);
  }

  state.tasksMeta = {
    totalTasks: taskCount,
    currentTaskIndex: 0,
    tasks,
  };

  return saveState(ticketId, state);
}

module.exports = {
  findTaskByNum,
  canStartFromState,
  canStart,
  initTasksMeta,
  _setParent,
};
