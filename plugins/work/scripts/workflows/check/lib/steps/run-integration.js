/**
 * Step: 8_run_integration — Run integration tests if SCRIPT_RUN_AFFECTED_INTEGRATION is set.
 * Runs after all review rounds, before final validation.
 * Skips silently if env var not configured.
 */

'use strict';

const { runAffectedSuite } = require('../run-affected-suite');

module.exports = function registerRunIntegration(register) {
  register(
    '8_run_integration',
    runAffectedSuite({
      envVar: 'SCRIPT_RUN_AFFECTED_INTEGRATION',
      stepName: '8_run_integration',
      reportFile: 'integration-tests.check.md',
      label: 'Integration',
      timeout: 600000,
    })
  );
};
