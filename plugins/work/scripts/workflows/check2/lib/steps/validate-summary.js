/**
 * Step: 7_validate_summary — Run validate-reports + generate-summary inline (deterministic).
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { hasWebApps } = require('../../../check/lib/has-web-apps');

/**
 * Build the positional args for `check-validate-reports.js`. The 3rd arg
 * (`<PLAYWRIGHT_SKIPPED_JSON>`) is derived deterministically from the check
 * plan's `state.setupResult` via the canonical `hasWebApps()` helper — never
 * from a human edit to the QA report (GH-280, P0 #2).
 *
 * @returns {[string, string, string]} [reportFolder, impactedAppsJson, playwrightSkippedJson]
 */
function buildValidateReportsArgs(state, env, tasksDir) {
  const reportFolder = state.setupResult?.reportFolder || tasksDir;
  const apps = JSON.stringify(state.setupResult?.impactedApps || []);
  const playwrightSkipped = !hasWebApps(state.setupResult?.impactedApps ?? [], env);
  return [reportFolder, apps, JSON.stringify(playwrightSkipped)];
}

function registerValidateSummary(register) {
  register('10_validate_summary', (state, ctx) => {
    // GH-280: thread a deterministic playwright-skip signal as the 3rd arg.
    const [reportFolder, apps, playwrightSkippedJson] = buildValidateReportsArgs(
      state,
      process.env,
      ctx.tasksDir
    );

    try {
      execFileSync(
        process.execPath,
        [
          path.join(ctx.checkHooksDir, 'check-validate-reports.js'),
          reportFolder,
          apps,
          playwrightSkippedJson,
        ],
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
}

module.exports = registerValidateSummary;
module.exports.buildValidateReportsArgs = buildValidateReportsArgs;
