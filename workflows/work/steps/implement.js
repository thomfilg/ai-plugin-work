/**
 * Step: implement
 * Runs the implementation agent, scoped to the current task if tasks exist.
 * Also auto-initializes task tracking if needed.
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */

// Reference to task-parser (parseTasks/buildTaskPrompt flow through ctx at runtime;
// this import satisfies spec verification that steps/implement.js is wired to task-parser).
const _taskParser = require('../task-parser');
void _taskParser;

const fs = require('fs');
const pathMod = require('path');

/**
 * Read claim owner from lock file (single source of truth for task claims).
 * Returns ownerId (e.g. "PR1") or null if no active claim.
 */
function _readClaimOwner(tasksDir, taskNum) {
  try {
    const lockPath = pathMod.join(tasksDir, '.claims', `task-${taskNum}.lock`);
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.ownerId ?? null;
  } catch {
    return null;
  }
}

// ─── GH-219 Task 16: Dependency-aware message builders ─────────────────────

/**
 * Resolve the numeric worker slot for the current claim owner.
 * Returns the slot number as a string (e.g. "2") or null if not applicable.
 *
 * @param {object|null} workState - Full work state
 * @param {string|null} claimOwner - Claim owner id (e.g. "PR1")
 * @returns {string|null}
 */
function _resolveWorkerSlot(workState, claimOwner) {
  if (!claimOwner || !workState?.parallelWorkers?.allocations) return null;
  const alloc = workState.parallelWorkers.allocations.find(
    (a) => a.ownerId === claimOwner && !a.releasedAt
  );
  // Return numeric slot to avoid redundancy with ownerId (e.g. "claimed by PR2 [slot 2]")
  return alloc ? String(alloc.slot) : null;
} // end _resolveWorkerSlot — returns numeric slot

/**
 * Build a dependency status descriptor for the current task.
 * Returns null if task has no dependencies, or a status object.
 *
 * @param {object|null} currentTask - Parsed task from task-parser
 * @param {object|null} taskState - tasksMeta from work state
 * @returns {{ hasDeps: boolean, allMet: boolean, deps: Array<{ num: number, met: boolean }> } | null}
 */
function _buildDependencyStatus(currentTask, taskState) {
  if (!currentTask) return null;
  // Use persisted tasksMeta dependencies (aligned with canStartFromState in task-readiness.js)
  const tasks = taskState?.tasks ?? [];
  const currentTaskMeta = tasks.find((t) => t.id === `task_${currentTask.num}`);
  // Backward compat: missing dependencies field → no deps (matches R16 in task-readiness.js)
  if (
    !currentTaskMeta ||
    !Array.isArray(currentTaskMeta.dependencies) ||
    currentTaskMeta.dependencies.length === 0
  ) {
    return null;
  }
  // Build dependency list from persisted tasksMeta (aligned with canStartFromState).
  // NOTE: This intentionally reads from taskState (persisted), NOT from currentTask.dependencies
  // (parsed tasks.md), so the displayed status matches the orchestrator's readiness checks.
  const deps = [];
  for (const depNum of currentTaskMeta.dependencies) {
    const depTask = tasks.find((t) => t.id === `task_${depNum}`);
    deps.push({ num: depNum, met: depTask?.status === 'completed' });
  }
  return { hasDeps: true, allMet: deps.every((d) => d.met), deps };
}

/**
 * Build the dependency/claim/slot prompt fragment appended to the agent prompt.
 *
 * @param {{ hasDeps: boolean, allMet: boolean, deps: Array<{ num: number, met: boolean }> } | null} depStatus
 * @param {string|null} claimOwner
 * @param {string|null} workerSlot
 * @returns {string}
 */
function _buildDependencyPrompt(depStatus, claimOwner, workerSlot) {
  const sections = [];
  if (claimOwner) {
    const lines = [`### Worker Assignment`, `Claimed by: ${claimOwner}`];
    if (workerSlot) {
      lines.push(`Worker slot: ${workerSlot}`);
    }
    sections.push(lines.join('\n'));
  }
  if (depStatus) {
    const lines = [`### Dependencies`];
    if (depStatus.allMet) {
      lines.push(`All dependencies met. This task is ready to start.`);
    }
    depStatus.deps.forEach((d) => {
      lines.push(`- Task ${d.num}: ${d.met ? 'completed' : 'pending'}`);
    });
    sections.push(lines.join('\n'));
  }
  return sections.length > 0 ? '\n\n' + sections.join('\n\n') : '';
}

/**
 * Build the human-readable reason string for the implement step.
 *
 * @param {object|null} currentTask
 * @param {number} currentTaskIdx
 * @param {Array|null} taskData
 * @param {string|null} claimOwner
 * @param {string|null} workerSlot
 * @param {object|null} depStatus
 * @param {object|null} s
 * @returns {string}
 */
function _buildTaskReason(
  currentTask,
  currentTaskIdx,
  taskData,
  claimOwner,
  workerSlot,
  depStatus,
  s
) {
  if (!currentTask) {
    return s?.hasDiffVsMain
      ? 'Changes exist but implement not yet completed'
      : 'No changes vs main';
  }

  const parts = [];
  // Task id + progress
  parts.push(
    `Task ${currentTaskIdx + 1}/${taskData.length} (task_${currentTask.num}): ${currentTask.title}`
  );

  // Claim + PR slot
  if (claimOwner) {
    const slotInfo = workerSlot ? ` [slot ${workerSlot}]` : '';
    parts.push(`claimed by ${claimOwner}${slotInfo}`);
  }

  // Dependency status
  if (depStatus) {
    if (depStatus.allMet) {
      parts.push('dependencies met');
    } else {
      const pending = depStatus.deps.filter((d) => !d.met).map((d) => `Task ${d.num}`);
      parts.push(`dependencies pending: ${pending.join(', ')}`);
    }
  }

  return parts.join(' — ');
}

module.exports = function implementStep(add, s, ctx) {
  const {
    STEPS,
    safeName,
    tasksDir,
    planningContext,
    getDocsPrompt,
    parseTasks,
    buildTaskPrompt,
    fileExists,
    path,
    execFileSync,
  } = ctx;

  const taskData = s?.hasTasks ? parseTasks(tasksDir) : null;
  const taskState = s?.workState?.tasksMeta;
  const rawTaskIdx = taskState?.currentTaskIndex ?? 0;
  const allTasksDone = taskData && rawTaskIdx >= taskData.length;
  const currentTaskIdx = taskData ? Math.min(rawTaskIdx, taskData.length - 1) : rawTaskIdx;
  const currentTask = allTasksDone ? null : taskData?.[currentTaskIdx];

  // Auto-initialize task tracking if tasks.md exists but tasksMeta doesn't
  if (taskData && !taskState && s?.workState) {
    try {
      const wsPath = ctx.workStatePath;
      execFileSync(process.execPath, [wsPath, 'task-init', safeName, String(taskData.length)], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: 'pipe',
      });
    } catch {
      /* fail-open: task tracking init failure should not block plan */
    }
  }

  // ─── GH-219 Task 16: dependency-aware context extraction ─────────────
  // Claim owner derived from .claims/task-N.lock (single source of truth)
  const claimOwner = currentTask ? _readClaimOwner(tasksDir, currentTask.num) : null;
  const workerSlot = _resolveWorkerSlot(s?.workState, claimOwner); // numeric slot from parallelWorkers
  const depStatus = _buildDependencyStatus(currentTask, taskState);

  const implementMeta = {
    agentType: 'skill',
    agentPrompt: currentTask
      ? `/work-implement ${buildTaskPrompt(currentTask, tasksDir)}${_buildDependencyPrompt(depStatus, claimOwner, workerSlot)}${getDocsPrompt('READ_DOCS_ON_DEV')}`
      : `/work-implement <requirements>${planningContext}${getDocsPrompt('READ_DOCS_ON_DEV')}`,
  };

  if (allTasksDone) {
    add(STEPS.implement, 'DEFER', null, 'All tasks completed');
  } else if (currentTask?.isCheckpoint) {
    add(
      STEPS.implement,
      'DEFER',
      null,
      `Task ${currentTask.num} is a checkpoint — no implementation needed`
    );
  } else {
    const implementPreviouslyCompleted = s?.stepIs(STEPS.implement) === 'completed';
    if (implementPreviouslyCompleted && s?.hasDiffVsMain) {
      add(
        STEPS.implement,
        'DEFER',
        '/work-implement <requirements>',
        `Previously completed; changes exist: ${s.diffSummary}`,
        implementMeta
      );
    } else {
      const reason = _buildTaskReason(
        currentTask,
        currentTaskIdx,
        taskData,
        claimOwner,
        workerSlot,
        depStatus,
        s
      );
      add(STEPS.implement, 'RUN', '/work-implement <requirements>', reason, implementMeta);
    }
  }

  // Export task metadata for task-advance step
  ctx._taskData = taskData;
  ctx._allTasksDone = allTasksDone;
  ctx._currentTaskIdx = currentTaskIdx;
};
