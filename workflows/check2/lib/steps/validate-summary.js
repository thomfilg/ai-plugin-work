/**
 * Step: 7_validate_summary — Run validate-reports + generate-summary inline (deterministic).
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

module.exports = function registerValidateSummary(register) {
  register('10_validate_summary', (state, ctx) => {
    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;
    const apps = JSON.stringify(state.setupResult?.impactedApps || []);

    try {
      execFileSync(
        process.execPath,
        [path.join(ctx.checkHooksDir, 'check-validate-reports.js'), reportFolder, apps],
        { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch {
      /* validation may exit non-zero for NEEDS_WORK — expected */
    }

    try {
      execFileSync(
        process.execPath,
        [
          path.join(ctx.checkHooksDir, 'check-generate-summary.js'),
          reportFolder,
          state.changesHash || 'unknown',
          state.ticketId,
          apps,
        ],
        { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch {
      /* fail-open */
    }

    return null; // auto-advance
  });
};
