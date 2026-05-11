/**
 * Step: pr
 * Creates or updates the pull request.
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function prStep(add, s, ctx) {
  const { STEPS, ticket, t, rework } = ctx;

  if (rework) {
    add(STEPS.pr, 'RUN', `/work-pr ${ticket} --force`, 'REWORK: Force update', {
      agentType: 'skill',
      agentPrompt: `/work-pr ${ticket} --force`,
    });
  } else if (s?.prShaMatch && s?.prEverUpdated && (s?.postPrShaMatch || !s?.contentSha)) {
    add(
      STEPS.pr,
      'DEFER',
      `/work-pr ${ticket || t}`,
      `SHA match (${s.headSha?.substring(0, 8)}, content: ${s?.postPrShaMatch ? 'match' : 'n/a'})`,
      {
        agentType: 'skill',
        agentPrompt: `/work-pr ${ticket || t}`,
      }
    );
  } else if (s?.prEverUpdated) {
    add(
      STEPS.pr,
      'RUN',
      `/work-pr ${ticket}`,
      `HEAD: ${s.prUpdateSha?.substring(0, 8) || '?'} → ${s.headSha?.substring(0, 8) || '?'}`,
      {
        agentType: 'skill',
        agentPrompt: `/work-pr ${ticket}`,
      }
    );
  } else {
    add(STEPS.pr, 'RUN', `/work-pr ${t}`, 'Must run once', {
      agentType: 'skill',
      agentPrompt: `/work-pr ${t}`,
    });
  }
};
