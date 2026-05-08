/**
 * Step: triage — Classify failure from monitor output.
 * Sets state.currentStep to fix-ci, fix-reviews, or report based on category.
 */

'use strict';

module.exports = function registerTriage(register) {
  register('triage', (state) => {
    const result = state.lastMonitorResult || {};
    const output = result.output || '';

    // Error (exit 2) — unrecoverable
    if (result.exitCode === 2) {
      return {
        type: 'follow_up_instruction',
        action: 'blocked',
        reason: `Monitor error: ${output.substring(0, 500)}`,
      };
    }

    // Classify failure
    const hasCiFailure = /CI.*fail|check.*fail|workflow.*fail|build.*fail/i.test(output);
    const hasConflict = /merge conflict|cannot be merged/i.test(output);
    const hasBlockingReviews = /blocking.*review|changes.*requested/i.test(output);

    if (hasConflict) {
      // Merge conflict — delegate to developer
      state.failureCategory = 'conflict';
      state.currentStep = 'fix-ci'; // reuse fix-ci for conflict resolution
      return null;
    }

    if (hasCiFailure) {
      state.failureCategory = 'ci_failure';
      state.currentStep = 'fix-ci';
      return null;
    }

    if (hasBlockingReviews) {
      state.failureCategory = 'reviews';
      state.currentStep = 'fix-reviews';
      return null;
    }

    // Unknown failure — delegate to developer with raw output
    state.failureCategory = 'unknown';
    state.currentStep = 'fix-ci';
    return null;
  });
};
