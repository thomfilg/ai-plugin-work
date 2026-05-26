/**
 * Step: report — Generate review-accountability.json on success. Marks complete.
 */

'use strict';

const fs = require('fs');
const path = require('path');

module.exports = function registerReport(register) {
  register('report', (state, ctx) => {
    // Final safety net: never mark complete while the latest monitor cycle
    // still shows merge conflicts. Catches the case where an earlier step
    // (triage/fix-ci) routed past a conflict without resolving it — e.g.
    // fix-ci falling through when there were no failing CI jobs to dispatch
    // a fix for. Send the workflow back to fix-ci instead.
    const lastOutput = (state.lastMonitorResult && state.lastMonitorResult.output) || '';
    if (state._isConflicting || /merge conflict|cannot be merged/i.test(lastOutput)) {
      state.failureCategory = 'conflict';
      state.currentStep = 'fix-ci';
      return null;
    }

    // Write accountability report if it doesn't exist
    const reportPath = path.join(ctx.tasksDir, 'review-accountability.json');
    const skippedReviews = state._skippedReviewsCount || 0;
    const solvedReviews = state._solvedReviewsCount || 0;
    if (!fs.existsSync(reportPath)) {
      try {
        fs.writeFileSync(
          reportPath,
          JSON.stringify(
            {
              ticketId: state.ticketId,
              prNumber: state.prNumber,
              attempts: state.attempt || 1,
              completedAt: new Date().toISOString(),
              status: 'success',
              reviewComments: { solved: solvedReviews, skipped: skippedReviews },
            },
            null,
            2
          )
        );
      } catch {
        /* fail-open */
      }
    }

    state.status = 'complete';

    const skipSuffix = skippedReviews
      ? ` — ${solvedReviews} review${solvedReviews !== 1 ? 's' : ''} fixed, ${skippedReviews} skipped (see follow-up-comments.json for rationale).`
      : '';

    return {
      type: 'follow_up_instruction',
      action: 'complete',
      state: { ticket: state.ticketId, currentStep: 'report', attempt: state.attempt },
      summary: `Follow-up complete for ${state.ticketId} PR #${state.prNumber || '?'} after ${state.attempt || 1} attempt(s)${skipSuffix}`,
    };
  });
};
