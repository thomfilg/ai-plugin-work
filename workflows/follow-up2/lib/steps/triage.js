/**
 * Step: triage — Parse monitor output to determine next action.
 *
 * Priority order:
 *   1. Merge conflict → fix-ci
 *   2. CI FAILING → fix-ci
 *   3. CI CANCELLED + merge blocked → fix-ci (cancelled check is required)
 *   4. CI CANCELLED + merge NOT blocked → treat as passing
 *   5. Blocking reviews with NO ongoing bot review → fix-reviews
 *   6. Ongoing bot review (awaiting) → report
 *   7. All clear → report
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

    const hasConflict = /merge conflict|cannot be merged/i.test(output);
    const hasCiFailure = /CI:\s*FAILING/i.test(output);
    const hasCiCancelled = /CI:\s*CANCELLED/i.test(output);
    const isMergeBlocked = /MERGE STATUS:\s*BLOCKED/i.test(output);
    const hasBlockingReviews = /Reviews:.*BLOCKING/i.test(output);
    const hasOngoingReview = /awaiting bot reviews/i.test(output);

    if (hasConflict) {
      state.failureCategory = 'conflict';
      state.currentStep = 'fix-ci';
      return null;
    }

    if (hasCiFailure) {
      state.failureCategory = 'ci_failure';
      state.currentStep = 'fix-ci';
      return null;
    }

    // CI cancelled: only care if it blocks the merge
    if (hasCiCancelled && isMergeBlocked && !hasBlockingReviews) {
      state.failureCategory = 'ci_cancelled_blocking';
      state.currentStep = 'fix-ci';
      return null;
    }

    if (hasBlockingReviews && !hasOngoingReview) {
      state.failureCategory = 'reviews';
      state.currentStep = 'fix-reviews';
      return null;
    }

    // Ongoing review, cancelled but non-blocking, or all clear → report
    state.currentStep = 'report';
    return null;
  });
};
