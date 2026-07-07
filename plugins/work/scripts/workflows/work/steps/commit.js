const path = require('path');

// Absolute path to the sanctioned commit script the session agent must use.
const COMMIT_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'commit-and-push.js');

/**
 * Step: commit
 *
 * GH-539: commit-writer was removed. The SESSION AGENT authors the commit
 * message inline (it has the context) and commits through the sanctioned
 * `commit-and-push.js` script — the ONLY path the `enforce-agent-usage` hook
 * allows (a raw `git commit` is always blocked). The script validates semantic
 * format, blocks AI attribution, enforces a human git identity, and pushes. So
 * the commit step no longer dispatches a subagent; it emits an `inline-commit`
 * directive that the orchestrator fills with a real semantic message.
 *
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function commitStep(add, s, ctx) {
  const { STEPS, t } = ctx;

  const directive =
    `Author a concise semantic commit message (type(scope): description) summarizing ` +
    `the staged changes for ${t}, referencing the ticket. Do NOT add any AI/tool ` +
    `attribution. Then run the sanctioned commit script (it stages, validates, ` +
    `commits, and pushes):\n` +
    `  node "${COMMIT_SCRIPT}" -m "<your message>"\n` +
    `A raw \`git commit\` is blocked. The script rejects a non-conforming message, ` +
    `an AI attribution line, or an AI git identity — fix and re-run if it does.`;

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
