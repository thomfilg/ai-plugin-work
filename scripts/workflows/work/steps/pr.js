/**
 * Step: pr
 * Creates or updates the pull request.
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function prStep(add, s, ctx) {
  const { STEPS, ticket, t, rework } = ctx;
  // Self-paced runner: skill drives pr-next.js between each sub-phase
  // (inputs → diff_audit → description_draft → validate_description →
  // create_or_update → attachments → memorize → done). Skip if rework
  // since rework is a forced single-shot.
  const driverHint = rework
    ? ''
    : `\n\nBefore and after each sub-action, run \`node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-pr-step/pr-next.js ${ticket || t}\` to validate and advance. Do NOT edit \`pr-phase.json\` directly.`;

  if (rework) {
    add(STEPS.pr, 'RUN', `/work-pr ${ticket} --force`, 'REWORK: Force update', {
      agentType: 'skill',
      agentPrompt: `/work-pr ${ticket} --force${driverHint}`,
    });
  } else if (s?.prShaMatch && s?.prEverUpdated && (s?.postPrShaMatch || !s?.contentSha)) {
    add(
      STEPS.pr,
      'DEFER',
      `/work-pr ${ticket || t}`,
      `SHA match (${s.headSha?.substring(0, 8)}, content: ${s?.postPrShaMatch ? 'match' : 'n/a'})`,
      {
        agentType: 'skill',
        agentPrompt: `/work-pr ${ticket || t}${driverHint}`,
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
        agentPrompt: `/work-pr ${ticket}${driverHint}`,
      }
    );
  } else {
    add(STEPS.pr, 'RUN', `/work-pr ${t}`, 'Must run once', {
      agentType: 'skill',
      agentPrompt: `/work-pr ${t}${driverHint}`,
    });
  }
};
