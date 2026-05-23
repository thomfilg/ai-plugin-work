/**
 * Step: ready
 * Marks the PR as ready for review (un-drafts it).
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function readyStep(add, s, ctx) {
  const { STEPS, worktreeDir } = ctx;

  if (s?.pr && !s.pr.isDraft) {
    add(STEPS.ready, 'DEFER', null, 'Already ready');
  } else {
    add(STEPS.ready, 'RUN', 'Task(Bash)', 'Mark PR ready', {
      agentType: 'Bash',
      agentPrompt: `cd "${worktreeDir}" && gh pr ready`,
    });
  }
};
