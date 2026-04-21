/**
 * Step: tasks
 * Generates tasks from the technical specification.
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function tasksStep(add, s, ctx) {
  const { STEPS, safeName, tasksDir, fileExists, path } = ctx;
  const tasksEnabled = process.env.WORK_TASKS_ENABLED !== '0';
  const specPath = path.join(tasksDir, 'spec.md');

  if (!tasksEnabled) {
    add(STEPS.tasks, 'DEFER', null, 'Task splitting disabled (WORK_TASKS_ENABLED=0)');
  } else if (s?.hasTasks) {
    add(STEPS.tasks, 'DEFER', null, 'tasks.md already exists');
  } else if (!fileExists(specPath)) {
    add(STEPS.tasks, 'DEFER', null, 'No spec.md — cannot generate tasks', {
      agentType: 'skill',
      agentPrompt: `/split-in-tasks ${safeName} --force`,
    });
  } else {
    add(STEPS.tasks, 'RUN', 'Skill(split-in-tasks)', 'Generate tasks from spec', {
      agentType: 'skill',
      agentPrompt: `/split-in-tasks ${safeName} --force`,
    });
  }
};
