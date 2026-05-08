/**
 * Step: 4_phase1_agents — Launch code-checker, quality-checker,
 * completion-checker in parallel.
 *
 * Returns a parallel_tasks instruction on first call.
 * On subsequent calls, checks if reports exist and auto-advances.
 */

'use strict';

const fs = require('fs');
const path = require('path');

module.exports = function registerPhase1(register) {
  register('4_phase1_agents', (state, ctx) => {
    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;
    const changesHash = state.changesHash || 'unknown';

    // Already dispatched — check if reports exist
    if (state.dispatched === '4_phase1_agents') {
      const hasCodeReview = fs.existsSync(path.join(reportFolder, 'code-review.check.md'));
      const hasTests = fs.existsSync(path.join(reportFolder, 'tests.check.md'));
      const hasCompletion = fs.existsSync(path.join(reportFolder, 'completion.check.md'));
      if (hasCodeReview && hasTests && hasCompletion) {
        return null; // all reports present → auto-advance
      }
      // Reports incomplete — re-dispatch
    }

    state.dispatched = '4_phase1_agents';

    return {
      type: 'check_instruction',
      action: 'execute',
      state: { ticket: state.ticketId, currentStep: '4_phase1_agents', progress: '4/9' },
      continue: true,
      delegate: {
        type: 'parallel_tasks',
        agents: [
          {
            agentType: 'code-checker',
            description: 'Code review',
            prompt: `Review code changes for ${state.ticketId}. Write report to ${reportFolder}/code-review.check.md. Changes hash: ${changesHash}`,
          },
          {
            agentType: 'quality-checker',
            description: 'Run tests',
            prompt: `Run tests for ${state.ticketId}. Write report to ${reportFolder}/tests.check.md. Changes hash: ${changesHash}`,
          },
          {
            agentType: 'completion-checker',
            description: 'Verify requirements',
            prompt: `Verify requirements for ${state.ticketId}. Write report to ${reportFolder}/completion.check.md. Changes hash: ${changesHash}`,
          },
        ],
        note: 'Launch ALL agents in parallel using multiple Task() calls in one message. Wait for all to complete.',
      },
    };
  });
};
