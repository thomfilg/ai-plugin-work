/**
 * Step: push-retry — Commit fixes, push, increment attempt, loop back to monitor.
 */

'use strict';

module.exports = function registerPushRetry(register) {
  register('push-retry', (state) => {
    state.attempt = (state.attempt || 0) + 1;

    if (state.attempt >= state.maxAttempts) {
      return {
        type: 'follow_up_instruction',
        action: 'blocked',
        reason: `Max attempts (${state.maxAttempts}) reached. PR still has issues.`,
      };
    }

    // Delegate commit-writer to commit + push
    if (state.dispatched === 'push-retry') {
      // Already committed — loop back to monitor
      state.currentStep = 'monitor';
      state.dispatched = null;
      state.failureCategory = null;
      return null;
    }

    state.dispatched = 'push-retry';

    return {
      type: 'follow_up_instruction',
      action: 'execute',
      state: { ticket: state.ticketId, currentStep: 'push-retry', attempt: state.attempt },
      continue: true,
      delegate: {
        type: 'task',
        agentType: 'commit-writer',
        description: `Commit follow-up fixes (attempt ${state.attempt})`,
        prompt: `autonomous - commit and push follow-up fixes for ${state.ticketId}`,
        note: 'Pass the prompt directly to the agent.',
      },
    };
  });
};
