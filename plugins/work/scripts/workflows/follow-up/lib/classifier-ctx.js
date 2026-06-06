/**
 * Classifier-context builder. Owns the contract the infra-classifier
 * consumes: `ctx.allJobs`, `ctx.prDiffFiles`, `ctx.rawLogs`, `ctx.failedTests`,
 * `ctx.exec`, `ctx.runId`, `ctx.jobId`, `ctx.ciStatus`.
 *
 * Extracted from `follow-up-next.js` so the helpers can be unit-tested in
 * isolation without booting the orchestrator loop.
 */

'use strict';

const cp = require('node:child_process');

const { buildChildEnv } = require('../../work/scripts/gh-exec');
const { loadPrDiffFiles } = require('./repo-meta');

// Build a bound exec function matching the shape signal2 / classifier expect:
//   exec(cmd) -> { stdout, stderr, status }
function buildExecForCtx(worktreeDir) {
  return (cmd) => {
    try {
      const stdout = cp.execSync(cmd, {
        cwd: worktreeDir,
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildChildEnv(),
      });
      return { stdout, stderr: '', status: 0 };
    } catch (err) {
      return {
        stdout: (err && err.stdout) || '',
        stderr: (err && err.stderr) || String((err && err.message) || ''),
        status: err && typeof err.status === 'number' ? err.status : 1,
      };
    }
  };
}

// Surface the ctx fields the infra-classifier and infra-retry step depend on.
// monitor.js populates state._ciFailedJobs / _ciAllJobs / _ciFailedLogs /
// _ciStatus during its poll; we surface those plus a bound exec and a cached
// PR diff list so the classifier can run pure (no shell-outs).
function buildClassifierCtx(state, worktreeDir) {
  const failedJobs = Array.isArray(state._ciFailedJobs) ? state._ciFailedJobs : [];
  const firstFailed = failedJobs[0] || {};
  // PR #542 cursor[bot]: signal3 reads state.failedTests. monitor.js writes
  // extracted paths to state._ciFailedTests; mirror onto state.failedTests so
  // the classifier's existing read works without a signature change, and
  // surface on ctx for future ctx-consumers. NOTE: this is a deliberate state
  // mutation for backward compatibility with the classifier's existing
  // signature — open design question, not in scope for cleanup here.
  const failedTests = Array.isArray(state._ciFailedTests) ? state._ciFailedTests : [];
  state.failedTests = failedTests;
  return {
    allJobs: Array.isArray(state._ciAllJobs) ? state._ciAllJobs : [],
    prDiffFiles: loadPrDiffFiles(worktreeDir),
    rawLogs: typeof state._ciFailedLogs === 'string' ? state._ciFailedLogs : '',
    failedTests,
    exec: buildExecForCtx(worktreeDir),
    // Bug C (GH-508): monitor.js records IDs on _ciFailedJobs only — state.runId
    // is never populated. Read both runId and jobId from the failed-job entry so
    // signal2's NUMERIC_ID validation receives real IDs instead of undefined.
    runId: firstFailed.runId || null,
    jobId: firstFailed.jobId || null,
    ciStatus: state._ciStatus || null,
  };
}

module.exports = { buildExecForCtx, buildClassifierCtx };
