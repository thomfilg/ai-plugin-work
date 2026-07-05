/**
 * Step: 10_validate_summary — Run validate-reports + generate-summary inline (deterministic).
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
// lib/config resolves WEB_APPS through the .env loader (repo .env / cwd .env),
// NOT just process.env — the same resolution every other check step uses.
const config = require(path.join(__dirname, '..', '..', '..', 'lib', 'config'));

/**
 * Skip signal for Playwright verification (GH-280): when no web apps are
 * configured, the plan skips 3_verify_playwright, so the QA report validator
 * must not require Playwright evidence. Uses config (dotenv-aware) rather
 * than a raw process.env.WEB_APPS read.
 * @returns {boolean}
 */
function playwrightSkipSignal() {
  try {
    return config.webAppNames().length === 0;
  } catch {
    return false; // fail closed — keep Playwright evidence required
  }
}

module.exports = function registerValidateSummary(register) {
  register('10_validate_summary', (state, ctx) => {
    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;
    const apps = JSON.stringify(state.setupResult?.impactedApps || []);
    const playwrightSkipped = JSON.stringify(playwrightSkipSignal());

    try {
      execFileSync(
        process.execPath,
        [
          path.join(ctx.checkHooksDir, 'check-validate-reports.js'),
          reportFolder,
          apps,
          playwrightSkipped,
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
};

module.exports.playwrightSkipSignal = playwrightSkipSignal;
