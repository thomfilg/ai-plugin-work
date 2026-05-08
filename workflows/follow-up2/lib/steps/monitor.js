/**
 * Step: monitor — Run follow-up-pr.js to check CI + reviews.
 *
 * Runs the full follow-up-pr.js with its adaptive polling loop
 * (40 attempts, 10s→30s→60s intervals). Handles long CI runs (20+ min).
 * No timeout — follow-up-pr.js has its own attempt limit.
 *
 * Exit codes: 0 = all clear, 1 = issues remain, 2 = error
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
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, args, {
        encoding: 'utf8',
        cwd: ctx.worktreeDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      exitCode = 0;
    } catch (err) {
      exitCode = typeof err.status === 'number' ? err.status : 1;
      stdout =
        typeof err.stdout === 'string'
          ? err.stdout
          : Buffer.isBuffer(err.stdout)
            ? err.stdout.toString()
            : '';
      const stderr =
        typeof err.stderr === 'string'
          ? err.stderr
          : Buffer.isBuffer(err.stderr)
            ? err.stderr.toString()
            : '';
      if (stderr) stdout += '\n' + stderr;
    }

    state.lastMonitorResult = { exitCode, output: stdout.substring(0, 3000) };

    if (exitCode === 0) {
      state.currentStep = 'report';
    }

    return null;
  });
};
