'use strict';

/**
 * Integration test for `validate-summary.js` (GH-280, Task 3).
 *
 * Scenario — P0 #2: the playwright-skip signal threaded to the validator CLI is
 * sourced deterministically from the check plan / runtime state
 * (`state.setupResult`), NOT from a human edit to the QA report.
 *
 * We exercise the exported args-builder seam, which derives the 3rd positional
 * argument (`<PLAYWRIGHT_SKIPPED_JSON>`) for `check-validate-reports.js` via the
 * canonical `hasWebApps()` helper.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const validateSummaryModule = require('../validate-summary');

const ORIGINAL_WEB_APPS = process.env.WEB_APPS;

function restoreEnv() {
  if (ORIGINAL_WEB_APPS === undefined) {
    delete process.env.WEB_APPS;
  } else {
    process.env.WEB_APPS = ORIGINAL_WEB_APPS;
  }
}

test('P0 #2 — Signal sourced deterministically from the check plan', async (t) => {
  await t.test('exposes an args-builder seam (no human-edit source)', () => {
    assert.equal(
      typeof validateSummaryModule.buildValidateReportsArgs,
      'function',
      'validate-summary.js must export buildValidateReportsArgs for deterministic signal threading'
    );
  });

  await t.test('no web apps → 3rd arg is JSON "true" (playwright skipped)', () => {
    delete process.env.WEB_APPS;
    const state = { setupResult: { impactedApps: ['plugin'], reportFolder: '/tmp/reports' } };
    const args = validateSummaryModule.buildValidateReportsArgs(state, process.env);

    // [ reportFolder, impactedAppsJson, playwrightSkippedJson ]
    assert.equal(args.length, 3, 'expected exactly 3 positional args');
    assert.equal(args[2], 'true', 'no web apps → skip signal must be JSON "true"');
    restoreEnv();
  });

  await t.test('web apps present → 3rd arg is JSON "false" (not skipped)', () => {
    process.env.WEB_APPS = '["app"]';
    const state = { setupResult: { impactedApps: ['app'], reportFolder: '/tmp/reports' } };
    const args = validateSummaryModule.buildValidateReportsArgs(state, process.env);

    assert.equal(args[2], 'false', 'web apps present → skip signal must be JSON "false"');
    restoreEnv();
  });

  await t.test('signal is derived from setupResult, not from the QA report', () => {
    delete process.env.WEB_APPS;
    const stateNoApps = { setupResult: { impactedApps: [], reportFolder: '/tmp/reports' } };
    const args = validateSummaryModule.buildValidateReportsArgs(stateNoApps, process.env);
    assert.equal(args[2], 'true', 'empty impactedApps + no WEB_APPS → skipped');
    restoreEnv();
  });
});
