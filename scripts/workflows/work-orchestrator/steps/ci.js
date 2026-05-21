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
  add(STEPS.ci, 'RUN', 'Task(Bash)', 'Wait for CI', {
    agentType: 'Bash',
    agentPrompt: `Run in ${worktreeDir}: gh pr checks --watch --interval 60

Then run \`node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-ci/ci-next.js ${tk}\` to advance through phases (inputs → wait → triage → fix_or_document → rerun_check → memorize → done). The runner classifies failures and gates on triage + fix evidence — do NOT edit \`ci-phase.json\` directly.

Return PASS if all checks pass, FAIL with details if any fail.`,
  });
};
