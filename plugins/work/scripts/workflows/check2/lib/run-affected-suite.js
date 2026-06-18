/**
 * Shared step body for the "run affected suite" check steps
 * (8_run_integration, 9_run_e2e). The two steps differ only in env var,
 * step id, report filename, label, and timeout — everything else (skip when
 * unconfigured, run the command, parse pass/fail counts, write the report,
 * fail on non-zero exit) is identical, so it lives here once.
 */

'use strict';

const fs = require('fs');
const path = require('path');
// Reuse the single command runner from run-tests.js rather than spawning here —
// one combined-output exec site for the whole /check2 subsystem.
const { runCommand } = require('./steps/run-tests');

// Pull pass/fail counts out of the runner output (best-effort; '?' when absent).
function parseCounts(output) {
  const passMatch = output.match(/pass\s+(\d+)/i);
  const failMatch = output.match(/fail\s+(\d+)/i);
  return {
    passCount: passMatch ? passMatch[1] : '?',
    failCount: failMatch ? failMatch[1] : '?',
  };
}

function buildReport({ status, label, envVar, exitCode, passCount, failCount, output }) {
  return [
    `Status: ${status}`,
    '',
    `# ${label} Test Results`,
    '',
    `**Runner:** ${envVar}`,
    `**Exit code:** ${exitCode}`,
    `**Pass:** ${passCount} | **Fail:** ${failCount}`,
    '',
    '## Output',
    '```',
    output.substring(0, 5000),
    '```',
  ].join('\n');
}

function runAffectedSuite({ envVar, stepName, reportFile, label, timeout }) {
  return (state, ctx) => {
    const cmd = process.env[envVar];
    if (!cmd) return null; // not configured → skip

    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;
    const reportPath = path.join(reportFolder, reportFile);

    const { output, exitCode } = runCommand(cmd, timeout);
    const { passCount, failCount } = parseCounts(output);
    const status = exitCode === 0 ? 'APPROVED' : 'NEEDS_WORK';

    fs.writeFileSync(
      reportPath,
      buildReport({ status, label, envVar, exitCode, passCount, failCount, output })
    );

    if (exitCode !== 0) {
      state.testsFailed = true;
      return {
        type: 'check_instruction',
        action: 'failed',
        state: { ticket: state.ticketId, currentStep: stepName },
        reason: `${label} tests failed (${failCount} failing).`,
        report: reportPath,
      };
    }

    return null;
  };
}

module.exports = { runAffectedSuite };
