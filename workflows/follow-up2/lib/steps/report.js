/**
 * Step: report — Generate review-accountability.json on success. Marks complete.
 */

'use strict';

const fs = require('fs');
const path = require('path');

module.exports = function registerReport(register) {
  register('report', (state, ctx) => {
    // Write accountability report if it doesn't exist
    const reportPath = path.join(ctx.tasksDir, 'review-accountability.json');
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

    return {
      type: 'follow_up_instruction',
      action: 'complete',
      state: { ticket: state.ticketId, currentStep: 'report', attempt: state.attempt },
      summary: `Follow-up complete for ${state.ticketId} PR #${state.prNumber || '?'} after ${state.attempt || 1} attempt(s).`,
    };
  });
};
