/**
 * Step: tasks
 * Generates tasks from the technical specification.
 *
 * Decision matrix:
 *   1. hasTasks=true     → DEFER (artifact already present)
 *   2. spec.md missing   → DEFER (dependency not met)
 *   3. spec.md exists    → RUN  (generate tasks from spec)
 *
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function tasksStep(add, s, ctx) {
  const { STEPS, safeName, tasksDir, fileExists, path } = ctx;
  const specPath = path.join(tasksDir, 'spec.md');

  if (s?.hasTasks) {
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
