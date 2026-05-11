/**
 * Step: follow_up
 * Addresses bot review comments and CI issues on the PR.
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function followUpStep(add, s, ctx) {
  const { STEPS } = ctx;

  if (!s?.pr || s.pr.isDraft) {
    add(
      STEPS.follow_up,
      'DEFER',
      'Skill(follow-up-pr)',
      !s?.pr ? 'No PR exists' : 'PR is still draft',
      {
        agentType: 'skill',
        agentPrompt: `/follow-up-pr`,
      }
    );
  } else {
    add(
      STEPS.follow_up,
      'RUN',
      'Skill(follow-up-pr)',
      'Address bot review comments and CI issues',
      {
        agentType: 'skill',
        agentPrompt: `/follow-up-pr`,
      }
    );
  }
};
