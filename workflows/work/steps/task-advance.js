/**
 * Step: task-advance (pseudo-step)
 * Augments the check plan entry with task-advance metadata when more tasks remain.
 * Does not add its own plan entry — it mutates the check entry.
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

  // Signal to the agent that more tasks remain after check passes
  if (!allTasksDone && currentTaskIdx < taskData.length - 1) {
    const checkEntry = plan.find((p) => p.step === STEPS.check);
    if (checkEntry) {
      checkEntry.nextAction = 'advance_task';
      checkEntry.taskInfo = {
        current: currentTaskIdx + 1,
        total: taskData.length,
        nextTask: taskData[currentTaskIdx + 1]?.title || 'unknown',
      };
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
