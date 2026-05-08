/**
 * Step: monitor — Run follow-up-pr.js to check CI + reviews.
 * Parses exit code and stores result for triage.
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

module.exports = function registerMonitor(register) {
  register('monitor', (state, ctx) => {
    const scriptPath = path.join(ctx.workScriptsDir, 'follow-up-pr.js');
    const args = [scriptPath];
    if (state.prNumber) args.push('--pr', String(state.prNumber));

    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync(process.execPath, args, {
        encoding: 'utf8',
        timeout: 120000, // 2 min — script has internal polling
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: ctx.worktreeDir,
      });
      exitCode = 0;
    } catch (err) {
      exitCode = err.status || 1;
      output = (err.stdout || '') + (err.stderr || '');
    }

    state.lastMonitorResult = { exitCode, output: output.substring(0, 2000) };

    if (exitCode === 0) {
      // Success — skip to report
      state.currentStep = 'report';
      return null;
    }

    // Failure — advance to triage
    return null;
  });
};
