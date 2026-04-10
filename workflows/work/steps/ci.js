/**
 * Step: ci
 * Waits for CI checks to pass on the PR.
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function ciStep(add, s, ctx) {
  const { STEPS, worktreeDir } = ctx;
  add(STEPS.ci, 'RUN', 'Task(Bash)', 'Wait for CI', {
    agentType: 'Bash',
    agentPrompt: `Run in ${worktreeDir}: gh pr checks --watch --interval 60\n\nReturn PASS if all checks pass, FAIL with details if any fail.`,
  });
};
