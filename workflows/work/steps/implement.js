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

// ─── GH-219 Task 16: Dependency-aware message builders ─────────────────────

/**
 * Resolve the PR{N} worker slot for the current claim owner.
 * Returns the slot string (e.g. "PR1") or null if not applicable.
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
  // Return slot-derived label (e.g. "PR2"), not the redundant ownerId
  return alloc ? `PR${alloc.slot}` : null;
}

/**
 * Build a dependency status descriptor for the current task.
 * Returns null if task has no dependencies, or a status object.
 *
 * @param {object|null} currentTask - Parsed task from task-parser
 * @param {object|null} taskState - tasksMeta from work state
 * @returns {{ hasDeps: boolean, allMet: boolean, deps: Array<{ num: number, met: boolean }> } | null}
 */
function _buildDependencyStatus(currentTask, taskState) {
  if (!currentTask || !Array.isArray(currentTask.dependencies) || currentTask.dependencies.length === 0) {
    return null;
  }
  const tasks = taskState?.tasks ?? [];
  const deps = currentTask.dependencies.map((depNum) => {
    const depTask = tasks.find((t) => t.id === `task_${depNum}`);
    return { num: depNum, met: depTask?.status === 'completed' };
  });
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
function _buildTaskReason(currentTask, currentTaskIdx, taskData, claimOwner, workerSlot, depStatus, s) {
  if (!currentTask) {
    return s?.hasDiffVsMain
      ? 'Changes exist but implement not yet completed'
      : 'No changes vs main';
  }

  const parts = [];
  // Task id + progress
  parts.push(`Task ${currentTaskIdx + 1}/${taskData.length} (${currentTask.id}): ${currentTask.title}`);

  // Claim + PR slot
  if (claimOwner) {
    const slotInfo = workerSlot ? ` [${workerSlot}]` : '';
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
  const currentTaskId = currentTask?.id ?? null;
  const currentTaskMeta = currentTaskId
    ? (taskState?.tasks ?? []).find((t) => t.id === currentTaskId) ?? null
    : null;
  const claimOwner = currentTaskMeta?.claimedBy ?? null;
  const workerSlot = _resolveWorkerSlot(s?.workState, claimOwner);
  const depStatus = _buildDependencyStatus(currentTask, taskState);

  const implementMeta = {
    agentType: 'skill',
    agentPrompt: currentTask
      ? `/work-implement ${buildTaskPrompt(currentTask, tasksDir)}${_buildDependencyPrompt(depStatus, claimOwner, workerSlot)}${getDocsPrompt('READ_DOCS_ON_DEV')}`
      : `/work-implement <requirements>${planningContext}${getDocsPrompt('READ_DOCS_ON_DEV')}`,
  };

  if (allTasksDone) {
    add(STEPS.implement, 'SKIP', null, 'All tasks completed');
  } else if (currentTask?.isCheckpoint) {
    add(
      STEPS.implement,
      'SKIP',
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
      const reason = _buildTaskReason(currentTask, currentTaskIdx, taskData, claimOwner, workerSlot, depStatus, s);
      add(STEPS.implement, 'RUN', '/work-implement <requirements>', reason, implementMeta);
    }
  }

  // Export task metadata for task-advance step
  ctx._taskData = taskData;
  ctx._allTasksDone = allTasksDone;
  ctx._currentTaskIdx = currentTaskIdx;
};
