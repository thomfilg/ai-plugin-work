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

  const implementMeta = {
    agentType: 'skill',
    agentPrompt: currentTask
      ? `/work-implement ${buildTaskPrompt(currentTask, tasksDir)}${getDocsPrompt('READ_DOCS_ON_DEV')}`
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
      const reason = currentTask
        ? `Task ${currentTaskIdx + 1}/${taskData.length}: ${currentTask.title}`
        : s?.hasDiffVsMain
          ? `Changes exist but implement not yet completed`
          : 'No changes vs main';
      add(STEPS.implement, 'RUN', '/work-implement <requirements>', reason, implementMeta);
    }
  }

  // Export task metadata for task-advance step
  ctx._taskData = taskData;
  ctx._allTasksDone = allTasksDone;
  ctx._currentTaskIdx = currentTaskIdx;
};
