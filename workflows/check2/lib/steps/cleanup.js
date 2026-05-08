/**
 * Step: 9_cleanup — Kill dev server sessions for this ticket.
 */

'use strict';

const { execSync } = require('child_process');

module.exports = function registerCleanup(register) {
  register('9_cleanup', (state) => {
    try {
      execSync(`tmux kill-session -t "${state.ticketId}-check" 2>/dev/null || true`, {
        timeout: 5000,
        stdio: 'pipe',
      });
    } catch {
      /* no sessions to kill */
    }

    state.status = 'complete';

    return {
      type: 'check_instruction',
      action: 'complete',
      state: { ticket: state.ticketId, currentStep: '9_cleanup', progress: '9/9' },
      summary: `Check workflow complete for ${state.ticketId}.`,
    };
  });
};
