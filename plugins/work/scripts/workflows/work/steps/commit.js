/**
 * Step: commit
 *
 * GH-539: commit-writer was removed. The SESSION AGENT authors the commit
 * message inline (it has the context), and the `commit-msg` validator hook
 * enforces the rules deterministically — semantic format, no AI attribution,
 * and a human git identity. So the commit step no longer dispatches a subagent;
 * it emits an `inline-commit` directive that the orchestrator fills with a real
 * semantic message and runs directly (`git add -A && git commit -m … && git push`).
 *
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function commitStep(add, s, ctx) {
  const { STEPS, t } = ctx;

  const directive =
    `Author a concise semantic commit message (type(scope): description) summarizing ` +
    `the staged changes for ${t}. Do NOT add any AI/tool attribution. Then run:\n` +
    `  git add -A && git commit -m "<your message>" && git push\n` +
    `The installed commit-msg validator hook will reject a non-conforming message, ` +
    `an AI attribution line, or an AI git identity.`;

  const emitInlineCommit = (reason) =>
    add(STEPS.commit, 'RUN', 'author + commit', reason, {
      agentType: 'inline-commit',
      agentPrompt: directive,
    });

  if (s?.hasUncommitted) {
    emitInlineCommit(`${s.uncommittedCount} uncommitted file(s)`);
  } else if (s?.hasCommitWithTicket) {
    // Already committed under this ticket and nothing left uncommitted — skip.
    add(STEPS.commit, 'DEFER', null, `Latest: "${s.lastCommitMsg}"`);
  } else if (!s?.hasDiffVsMain) {
    add(STEPS.commit, 'PENDING', null, 'Depends on implement');
  } else {
    emitInlineCommit('Commit missing ticket ID');
  }
};
