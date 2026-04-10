/**
 * Step: bootstrap
 * Creates worktree and/or ensures PR exists.
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function bootstrapStep(add, s, ctx) {
  const { STEPS, ticket, t } = ctx;

  if (s?.worktreeExists && s?.pr) {
    add(STEPS.bootstrap, 'SKIP', null, `Worktree + PR #${s.pr.number} exist`);
  } else if (s?.worktreeExists) {
    add(STEPS.bootstrap, 'RUN', `/bootstrap ${ticket}`, 'Worktree exists but no PR', {
      agentType: 'skill',
      agentPrompt: `/bootstrap ${ticket}`,
    });
  } else {
    add(STEPS.bootstrap, 'RUN', `/bootstrap ${t}`, 'No worktree found', {
      agentType: 'skill',
      agentPrompt: `/bootstrap ${t}`,
    });
  }
};
