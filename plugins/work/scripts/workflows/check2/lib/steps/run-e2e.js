/**
 * Step: 9_run_e2e — Run e2e tests if SCRIPT_RUN_AFFECTED_E2E is set.
 * Runs after integration tests, before final validation.
 * Skips silently if env var not configured.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

module.exports = function registerRunE2e(register) {
  register('9_run_e2e', (state, ctx) => {
    const cmd = process.env.SCRIPT_RUN_AFFECTED_E2E;
    if (!cmd) return null; // not configured → skip

    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;
    const reportPath = path.join(reportFolder, 'e2e-tests.check.md');

    let output = '';
    let exitCode = 0;
    try {
      output = execSync(`${cmd} 2>&1`, { encoding: 'utf8', timeout: 900000 }); // 15min for e2e
    } catch (err) {
      exitCode = err.status || 1;
      output = (err.stdout || '') + (err.stderr || '');
    }

    const passMatch = output.match(/pass\s+(\d+)/i);
    const failMatch = output.match(/fail\s+(\d+)/i);
    const passCount = passMatch ? passMatch[1] : '?';
    const failCount = failMatch ? failMatch[1] : '?';
    const status = exitCode === 0 ? 'APPROVED' : 'NEEDS_WORK';

    fs.writeFileSync(reportPath, [
      `Status: ${status}`,
      '',
      '# E2E Test Results',
      '',
      `**Runner:** SCRIPT_RUN_AFFECTED_E2E`,
      `**Exit code:** ${exitCode}`,
      `**Pass:** ${passCount} | **Fail:** ${failCount}`,
      '',
      '## Output',
      '```',
      output.substring(0, 5000),
      '```',
    ].join('\n'));

    if (exitCode !== 0) {
      state.testsFailed = true;
      return {
        type: 'check_instruction',
        action: 'failed',
        state: { ticket: state.ticketId, currentStep: '9_run_e2e' },
        reason: `E2E tests failed (${failCount} failing).`,
        report: reportPath,
      };
    }

    return null;
  });
};
