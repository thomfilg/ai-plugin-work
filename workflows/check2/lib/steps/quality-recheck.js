/**
 * Step: 6_quality_recheck — Re-run quality checks if code was modified during consensus.
 * Skips if no files were modified.
 */

'use strict';

const { execSync } = require('child_process');

module.exports = function registerQualityRecheck(register) {
  register('7_quality_recheck', (state) => {
    // Check if code was modified during consensus
    let hasModifiedFiles = false;
    try {
      const status = execSync('git status --porcelain', { encoding: 'utf8', timeout: 5000 }).trim();
      hasModifiedFiles = status !== '';
    } catch {
      /* fail-open */
    }

    if (!hasModifiedFiles) return null; // no changes → skip

    if (state.dispatched === '7_quality_recheck') return null; // already ran → advance

    state.dispatched = '7_quality_recheck';

    return {
      type: 'check_instruction',
      action: 'execute',
      state: { ticket: state.ticketId, currentStep: '7_quality_recheck', progress: '6/9' },
      continue: true,
      delegate: {
        type: 'task',
        agentType: 'work-workflow:quality-checker',
        description: 'Re-check after code review fixes',
        prompt: `Re-run tests for ${state.ticketId} after code review fixes. Verify all tests still pass.`,
        note: 'Pass the prompt directly to the agent.',
      },
    };
  });
};
