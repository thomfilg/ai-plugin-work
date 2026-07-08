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
      // GH-394 / echo-5224: export CHANGED_SPECS (strictly-changed spec files
      // + importers of changed helpers) and E2E_PER_SPEC_TIMEOUT_MS
      // (CHECK_E2E_SPEC_TIMEOUT_MS, default 60s) to the suite command so the
      // reliability sweep is scoped and the per-spec budget is configurable.
      scopeSpecs: true,
    })
  );
};
