/**
 * Step: cleanup
 * Kills any active dev tmux session for the ticket.
 * DEFER when no session yet exists, as it may start during implement.
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function cleanupStep(add, s, ctx) {
  const { STEPS, ticket } = ctx;

  if (s?.hasDevSession) {
    add(STEPS.cleanup, 'RUN', `Task(Bash)`, 'Dev session running', {
      agentType: 'Bash',
      agentPrompt: `Run: tmux kill-session -t "${ticket}-dev" 2>/dev/null; echo "Cleanup done"`,
    });
  } else {
    add(STEPS.cleanup, 'DEFER', `Task(Bash)`, 'No dev session yet — re-check at step time', {
      agentType: 'Bash',
      agentPrompt: `Run: tmux kill-session -t "${ticket}-dev" 2>/dev/null; echo "Cleanup done (or no session)"`,
    });
  }
};
