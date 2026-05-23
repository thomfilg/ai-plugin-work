/**
 * Step: reports
 * Verifies and consolidates check reports in the tasks directory.
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function reportsStep(add, s, ctx) {
  const { STEPS, tasksDir } = ctx;
  add(STEPS.reports, 'RUN', 'Task(Bash)', 'Move reports to tasks/', {
    agentType: 'Bash',
    agentPrompt: `ls "${tasksDir}"/*.check.md 2>/dev/null; ls "${tasksDir}"/*.check.md 2>/dev/null | wc -l`,
  });
};
