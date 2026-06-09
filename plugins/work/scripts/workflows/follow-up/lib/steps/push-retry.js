/**
 * Step: push-retry — Push committed fixes, increment attempt, loop back to monitor.
 *
 * Each fix-reviews comment gets its own commit. This step just pushes
 * all pending commits to origin. If nothing to push, loops back silently.
 */

'use strict';

const { execFileSync } = require('child_process');

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
    if (state._pushRetryCount >= maxAttempts) {
      const ticketId = state.ticketId;
      const instruction = `Run: workflow-engine reset-follow-up ${ticketId} --yes`;
      return {
        type: 'follow_up_instruction',
        action: 'blocked',
        reason: `Max push-retry cycles (${maxAttempts}) reached. PR still has issues.`,
        instruction,
        nextAction: {
          command: 'workflow-engine',
          subcommand: 'reset-follow-up',
          args: [ticketId, '--yes'],
        },
      };
    }

    // Already pushed — loop back to monitor
    if (state.dispatched === 'push-retry') {
      state.currentStep = 'monitor';
      state.dispatched = null;
      state.failureCategory = null;
      return null;
    }

    // Check if there are commits to push
    let hasUnpushed = false;
    try {
      const count = execFileSync('git', ['rev-list', '--count', '@{upstream}..HEAD'], {
        encoding: 'utf8',
        timeout: 5000,
        cwd: ctx.worktreeDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      hasUnpushed = parseInt(count, 10) > 0;
    } catch {
      // No upstream or git error — check for uncommitted changes as fallback
      try {
        const porcelain = execFileSync('git', ['status', '--porcelain'], {
          encoding: 'utf8',
          timeout: 5000,
          cwd: ctx.worktreeDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        hasUnpushed = porcelain.length > 0;
      } catch {
        hasUnpushed = false;
      }
    }

    if (!hasUnpushed) {
      // Nothing to push — all comments were skipped, loop back
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
        type: 'bash',
        description: `Push follow-up fixes for ${state.ticketId}`,
        command: `cd "${ctx.worktreeDir}" && git push`,
      },
    };
  });
};
