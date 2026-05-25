/**
 * Step: ci
 * Waits for CI checks to pass on the PR.
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function ciStep(add, s, ctx) {
  const { STEPS, worktreeDir, ticket, t } = ctx;
  const tk = ticket || t;
  add(STEPS.ci, 'RUN', 'Task(Bash)', 'Wait for CI and PR merge', {
    agentType: 'Bash',
    agentPrompt: `cd "${worktreeDir}" && gh pr checks --watch --interval 60
Then run: node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-ci/ci-next.js ${tk}

Follow the instructions ci-next.js prints for the current phase. Re-invoke it as those instructions say. Do NOT edit ci-phase.json.`,
  });
};
