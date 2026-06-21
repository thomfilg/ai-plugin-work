/**
 * Step: push-retry — Push committed fixes, increment attempt, loop back to monitor.
 *
 * Each fix-reviews comment gets its own commit. This step just pushes
 * all pending commits to origin. If nothing to push, loops back silently.
 */

'use strict';

const { execFileSync } = require('child_process');

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

// True when there are commits ahead of upstream. Falls back to a porcelain
// dirty-tree check when there's no upstream (or git errors).
function hasUnpushedCommits(ctx) {
  const opts = {
    encoding: 'utf8',
    timeout: 5000,
    cwd: ctx.worktreeDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  try {
    const count = execFileSync('git', ['rev-list', '--count', '@{upstream}..HEAD'], opts).trim();
    return parseInt(count, 10) > 0;
  } catch {
    // No upstream or git error — check for uncommitted changes as fallback
    try {
      return execFileSync('git', ['status', '--porcelain'], opts).trim().length > 0;
    } catch {
      return false;
    }
  }
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
    if (!hasUnpushedCommits(ctx)) return loopBackToMonitor(state);

    state.dispatched = 'push-retry';
    return buildPushDelegate(state, ctx);
  });
};
