/**
 * Step: task-advance (pseudo-step)
 * Augments the check and task_review plan entries with task-advance metadata
 * when more tasks remain. Does not add its own plan entry — it mutates
 * existing entries.
 *
 * GH-211: Also mutates the task_review plan entry and calls
 * resetTaskReviewFixRounds to reset fix-round counter for the next task.
 *
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function taskAdvanceStep(add, s, ctx) {
  const { STEPS, plan } = ctx;
  const taskData = ctx._taskData;
  const allTasksDone = ctx._allTasksDone;
  const currentTaskIdx = ctx._currentTaskIdx;

  if (!taskData || !plan) return;

  // GH-211: Fix-round counter reset is handled by work-state.js advanceTask()
  // directly (see line ~605), which is invoked by the `work-state task-advance`
  // CLI command during actual task advancement. This step module only mutates
  // the plan entries; it does NOT perform state mutations during plan generation.

  // Signal to the agent that more tasks remain after check passes
  if (!allTasksDone && currentTaskIdx < taskData.length - 1) {
    const taskInfo = {
      current: currentTaskIdx + 1,
      total: taskData.length,
      nextTask: taskData[currentTaskIdx + 1]?.title || 'unknown',
    };

    const checkEntry = plan.find((p) => p.step === STEPS.check);
    if (checkEntry) {
      checkEntry.nextAction = 'advance_task';
      checkEntry.taskInfo = taskInfo;
    }

    // GH-211: Also mutate task_review entry for non-final tasks
    const taskReviewEntry = plan.find((p) => p.step === STEPS.task_review);
    if (taskReviewEntry) {
      taskReviewEntry.nextAction = 'advance_task';
      taskReviewEntry.taskInfo = taskInfo;
    }
  }

  // Mark final task completion when this is the last task
  if (!allTasksDone && currentTaskIdx === taskData.length - 1) {
    const checkEntry = plan.find((p) => p.step === STEPS.check);
    if (checkEntry) {
      checkEntry.finalTaskAction = 'complete_last_task';
      checkEntry.taskInfo = {
        current: currentTaskIdx + 1,
        total: taskData.length,
        isLast: true,
      };
    }
  }
};
