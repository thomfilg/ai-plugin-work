/**
 * Step: push-retry — Push committed fixes, increment attempt, loop back to monitor.
 *
 * Each fix-reviews comment gets its own commit. This step just pushes
 * all pending commits to origin. If nothing to push, loops back silently.
 */

'use strict';

const { hasUnpushedCommits } = require('../git-unpushed');

// Loop back to monitor for the next cycle. Returns null (the "advance" signal).
function loopBackToMonitor(state) {
  state.currentStep = 'monitor';
  state.dispatched = null;
  state.failureCategory = null;
  return null;
}

function buildMaxAttemptsBlocked(state, maxAttempts) {
  const ticketId = state.ticketId;
  return {
    type: 'follow_up_instruction',
    action: 'blocked',
    reason: `Max push-retry cycles (${maxAttempts}) reached. PR still has issues.`,
    instruction: `Run: workflow-engine reset-follow-up ${ticketId} --yes`,
    nextAction: {
      command: 'workflow-engine',
      subcommand: 'reset-follow-up',
      args: [ticketId, '--yes'],
    },
  };
}

function buildPushDelegate(state, ctx) {
  return {
    type: 'follow_up_instruction',
    action: 'execute',
    state: { ticket: state.ticketId, currentStep: 'push-retry', attempt: state.attempt },
    continue: true,
    delegate: {
      type: 'bash',
      description: `Push follow-up fixes for ${state.ticketId}`,
      command: `cd "${ctx.worktreeDir}" && git push`,
    },
  };
}

module.exports = function registerPushRetry(register) {
  register('push-retry', (state, ctx) => {
    // Reset CI monitoring state for the next cycle
    state.attempt = 0;
    delete state._monitorStartTime;

    // Only increment on fresh entry, not on re-entry after dispatch
    if (state.dispatched !== 'push-retry') {
      state._pushRetryCount = (state._pushRetryCount || 0) + 1;
    }
    const maxAttempts = state.maxAttempts || 40;
    if (state._pushRetryCount >= maxAttempts) return buildMaxAttemptsBlocked(state, maxAttempts);

    // Already pushed — loop back to monitor
    if (state.dispatched === 'push-retry') return loopBackToMonitor(state);

    // Nothing to push — all comments were skipped, loop back
    if (!hasUnpushedCommits(ctx.worktreeDir)) return loopBackToMonitor(state);

    state.dispatched = 'push-retry';
    return buildPushDelegate(state, ctx);
  });
};
