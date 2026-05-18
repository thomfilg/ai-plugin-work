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

  // Always notify the workflow manager that this ticket's session is
  // finishing — this both (a) stops the agent's local listener on the
  // ticket channel cleanly via the __MONITOR_DONE__ sentinel and
  // (b) lets the MONITOR-side manager mark the channel completed.
  const doneCmd = `node "$CLAUDE_PLUGIN_ROOT/scripts/communicate.js" --done "${ticket}" workflow-complete 2>/dev/null || true`;

  if (s?.hasDevSession) {
    add(STEPS.cleanup, 'RUN', `Task(Bash)`, 'Dev session running', {
      agentType: 'Bash',
      agentPrompt: `Run: tmux kill-session -t "${ticket}-dev" 2>/dev/null; ${doneCmd}; echo "Cleanup done"`,
    });
  } else {
    add(STEPS.cleanup, 'DEFER', `Task(Bash)`, 'No dev session yet — re-check at step time', {
      agentType: 'Bash',
      agentPrompt: `Run: tmux kill-session -t "${ticket}-dev" 2>/dev/null; ${doneCmd}; echo "Cleanup done (or no session)"`,
    });
  }
};
