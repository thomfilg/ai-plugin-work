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
  // The runner is agent-gated (pr-generator / pr-post-generator only), so this
  // hint is addressed to the agent the skill dispatches — NOT to the session
  // reading it. Running pr-next.js here is blocked with "not running in an
  // authorized agent", and a session that tries anyway burns a turn on a
  // refusal, so the hint says who it is for and how to forward it.
  const driverHint = rework
    ? ''
    : `\n\nThe pr step is phase-driven by \`pr-next.js\`, which ONLY the pr-generator and pr-post-generator agents may run — a Bash call from this session is blocked by design, so do not make one. Instead include this instruction verbatim in the prompt the skill dispatches to pr-generator / pr-post-generator:\n  "Before and after each sub-action, run \`node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-pr-step/pr-next.js ${ticket || t}\` to validate and advance. Do NOT edit \`pr-phase.json\` directly."`;

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
