/**
 * Step: commit
 * Commits uncommitted changes with the ticket ID.
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function commitStep(add, s, ctx) {
  const { STEPS, t } = ctx;

  if (s?.hasUncommitted) {
    add(STEPS.commit, 'RUN', 'Task(commit-writer)', `${s.uncommittedCount} uncommitted file(s)`, {
      agentType: 'commit-writer',
      agentPrompt: `autonomous - commit staged changes for ${t}`,
    });
  } else if (s?.hasCommitWithTicket) {
    add(STEPS.commit, 'DEFER', 'Task(commit-writer)', `Latest: "${s.lastCommitMsg}"`, {
      agentType: 'commit-writer',
      agentPrompt: `autonomous - commit staged changes for ${t}`,
    });
  } else if (!s?.hasDiffVsMain) {
    add(STEPS.commit, 'PENDING', null, 'Depends on implement');
  } else {
    add(STEPS.commit, 'RUN', 'Task(commit-writer)', 'Commit missing ticket ID', {
      agentType: 'commit-writer',
      agentPrompt: `autonomous - commit staged changes for ${t}`,
    });
  }
};
