/**
 * Step: 9_run_e2e — Run e2e tests if SCRIPT_RUN_AFFECTED_E2E is set.
 * Runs after integration tests, before final validation.
 * Skips silently if env var not configured.
 */

'use strict';

const { runAffectedSuite } = require('../run-affected-suite');

module.exports = function registerRunE2e(register) {
  register(
    '9_run_e2e',
    runAffectedSuite({
      envVar: 'SCRIPT_RUN_AFFECTED_E2E',
      stepName: '9_run_e2e',
      reportFile: 'e2e-tests.check.md',
      label: 'E2E',
      timeout: 900000, // 15min for e2e
    })
  );
};
