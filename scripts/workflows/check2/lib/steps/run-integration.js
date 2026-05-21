/**
 * Step: 8_run_integration — Run integration tests if SCRIPT_RUN_AFFECTED_INTEGRATION is set.
 * Runs after all review rounds, before final validation.
 * Skips silently if env var not configured.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

module.exports = function registerRunIntegration(register) {
  register('8_run_integration', (state, ctx) => {
    const cmd = process.env.SCRIPT_RUN_AFFECTED_INTEGRATION;
    if (!cmd) return null; // not configured → skip

    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;
    const reportPath = path.join(reportFolder, 'integration-tests.check.md');

    let output = '';
    let exitCode = 0;
    try {
      output = execSync(`${cmd} 2>&1`, { encoding: 'utf8', timeout: 600000 });
    } catch (err) {
      exitCode = err.status || 1;
      output = (err.stdout || '') + (err.stderr || '');
    }

    const passMatch = output.match(/pass\s+(\d+)/i);
    const failMatch = output.match(/fail\s+(\d+)/i);
    const passCount = passMatch ? passMatch[1] : '?';
    const failCount = failMatch ? failMatch[1] : '?';
    const status = exitCode === 0 ? 'APPROVED' : 'NEEDS_WORK';

    fs.writeFileSync(
      reportPath,
      [
        `Status: ${status}`,
        '',
        '# Integration Test Results',
        '',
        `**Runner:** SCRIPT_RUN_AFFECTED_INTEGRATION`,
        `**Exit code:** ${exitCode}`,
        `**Pass:** ${passCount} | **Fail:** ${failCount}`,
        '',
        '## Output',
        '```',
        output.substring(0, 5000),
        '```',
      ].join('\n')
    );

    if (exitCode !== 0) {
      state.testsFailed = true;
      return {
        type: 'check_instruction',
        action: 'failed',
        state: { ticket: state.ticketId, currentStep: '8_run_integration' },
        reason: `Integration tests failed (${failCount} failing).`,
        report: reportPath,
      };
    }

    return null;
  });
};
