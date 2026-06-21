/**
 * Step: monitor — Check PR CI status + reviews.
 *
 * Calls follow-up-pr.js functions as a module (not subprocess).
 * This allows tests to mock ghExec and verify the full flow.
 *
 * Uses the exported functions: getPRInfo, checkCI, getReviews, formatReport.
 * formatReport produces the same output the agent would see from the CLI.
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { buildChildEnv } = require('../../../work/scripts/gh-exec');
const {
  writeMonitorResult,
  appendInitHintIfInfra,
  clearStaleInfraCache,
} = require('./monitor-infra-cache');
const {
  buildInitialFailedJobs,
  resolveMissingRunIds,
  mapCiStatus,
  fetchClassifierContext,
  attachJobIds,
  extractFailedTestPaths,
} = require('./monitor-ci-context');
const { buildOutput, buildStatusLine } = require('./monitor-status-line');

/**
 * Check if any workflow run for the PR's branch has already failed.
 * GitHub Actions matrix jobs: individual shards complete and fail
 * but `gh pr checks` still shows the parent as "in_progress".
 * `gh run list` sees the run-level conclusion sooner.
 */
function hasFailedJobs(prInfo, worktreeDir) {
  try {
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
      cwd: worktreeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const raw = execFileSync(
      'gh',
      [
        'api',
        `repos/{owner}/{repo}/commits/${headSha}/check-runs`,
        '--jq',
        '.check_runs[] | select(.conclusion == "failure") | .name',
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: worktreeDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildChildEnv(),
      }
    ).trim();

    return raw.length > 0;
  } catch {
    return false; // fail-open
  }
}

// Synchronous sleep via Atomics.wait — no subprocess, no event-loop dependency.
function sleepSync(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch {
    /* sleep best-effort */
  }
}

// GitHub returns `mergeable: UNKNOWN` for up to ~30s after a push or sibling-PR
// merge. Retry a few times before trusting UNKNOWN. Bounded (3 * 3s = 9s).
function refreshPrUntilKnown(getPRInfo, prArg, prInfo) {
  let retries = 0;
  let current = prInfo;
  while (current && current.mergeable === 'UNKNOWN' && retries < 3) {
    retries++;
    sleepSync(3000);
    try {
      current = getPRInfo(prArg);
    } catch {
      break;
    }
  }
  return { prInfo: current, retries };
}

function extractConflictFiles(tree, max) {
  const files = [];
  for (const line of tree.split('\n')) {
    const m =
      line.match(/^CONFLICT \([^)]+\):.*?(?:in|on) (.+?)$/) || line.match(/^Auto-merging (.+?)$/);
    if (m && !files.includes(m[1])) files.push(m[1]);
    if (files.length >= max) break;
  }
  return files;
}

function computeMergeBase(worktreeDir, baseBranch) {
  execFileSync('git', ['fetch', 'origin', baseBranch], {
    stdio: 'ignore',
    cwd: worktreeDir,
    timeout: 30000,
  });
  return execFileSync('git', ['merge-base', 'HEAD', `origin/${baseBranch}`], {
    encoding: 'utf8',
    cwd: worktreeDir,
    timeout: 10000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

// Run `git merge-tree` and classify the result. A non-zero/non-null exit code
// OR a CONFLICT marker in the combined stdout+stderr means conflicts.
function mergeTreeConflicts(mb, baseBranch, worktreeDir) {
  const { spawnSync } = require('child_process');
  const res = spawnSync(
    'git',
    ['merge-tree', `--merge-base=${mb}`, 'HEAD', `origin/${baseBranch}`],
    {
      encoding: 'utf8',
      cwd: worktreeDir,
      timeout: 30000,
    }
  );
  const tree = (res && (res.stdout || '')) + (res && res.stderr ? res.stderr : '');
  const hasExitCode = res && res.status !== 0 && res.status !== null;
  const hasMarker = /^CONFLICT \(/m.test(tree);
  return { conflicting: !!(hasExitCode || hasMarker), tree };
}

// Local `git merge-tree` cross-check against the PR's base branch.
// Authoritative against GitHub's false-clean cases (stacked PRs, stale cache).
function detectLocalConflict(baseBranch, worktreeDir) {
  const result = { conflicting: false, files: [] };
  if (!baseBranch || !worktreeDir) return result;
  try {
    const mb = computeMergeBase(worktreeDir, baseBranch);
    if (!mb) return result;
    const { conflicting, tree } = mergeTreeConflicts(mb, baseBranch, worktreeDir);
    if (conflicting) {
      result.conflicting = true;
      result.files = extractConflictFiles(tree, 3);
    }
  } catch {
    /* network/auth failure → trust API */
  }
  return result;
}

function emptyReviews() {
  return {
    all: [],
    comments: [],
    actionable: [],
    blocking: [],
    nonBlocking: [],
    pendingBots: [],
    hasBlocking: false,
    hasActionable: false,
  };
}

function fetchPrInfoOrFail(state, getPRInfo, prArg) {
  try {
    const prInfo = getPRInfo(prArg);
    if (!prInfo || !prInfo.number) {
      writeMonitorResult(state, { exitCode: 2, output: 'No PR found.' });
      return null;
    }
    return prInfo;
  } catch (err) {
    writeMonitorResult(state, { exitCode: 2, output: `Error getting PR info: ${err.message}` });
    return null;
  }
}

function recordMergeStatus(state, prInfo, mergeableRetries, local) {
  const apiConflicting = prInfo.mergeable === 'CONFLICTING' || prInfo.mergeStateStatus === 'DIRTY';
  state._mergeStatus = {
    mergeable: prInfo.mergeable || 'UNKNOWN',
    mergeStateStatus: prInfo.mergeStateStatus || 'UNKNOWN',
    baseBranch: prInfo.baseBranch || null,
    apiConflicting,
    localConflicting: local.conflicting,
    localConflictFiles: local.files,
    isConflicting: apiConflicting || local.conflicting,
    retries: mergeableRetries,
  };
  state._isConflicting = state._mergeStatus.isConflicting;
}

function computeExitCode(prInfo, ci, reviews) {
  const ciOk = ci.status === 'passing' || ci.status === 'no-checks';
  const reviewsOk =
    !reviews.hasBlocking && (!reviews.pendingBots || reviews.pendingBots.length === 0);
  const mergeOk = prInfo.mergeable !== 'CONFLICTING' && prInfo.mergeStateStatus !== 'DIRTY';
  return ciOk && reviewsOk && mergeOk ? 0 : 1;
}

// Read CI status; promote 'pending' to 'failing' when a matrix shard already
// failed. Writes a monitor-error result and returns null on a checkCI throw.
function fetchCi(state, prInfo, checkCI, worktreeDir) {
  let ci;
  try {
    ci = checkCI(prInfo.number);
  } catch (err) {
    writeMonitorResult(state, { exitCode: 2, output: `Error checking CI: ${err.message}` });
    return null;
  }
  if (ci.status === 'pending' && hasFailedJobs(prInfo, worktreeDir)) ci.status = 'failing';
  return ci;
}

function fetchReviews(prInfo, getReviews) {
  try {
    return getReviews(prInfo.number);
  } catch {
    return emptyReviews();
  }
}

function emitStatusLine(state, ci, reviews) {
  if (!state._monitorStartTime) state._monitorStartTime = new Date().toISOString();
  const { line1, detail } = buildStatusLine(state, ci, reviews);
  process.stderr.write(line1 + '\n');
  if (detail) process.stderr.write(detail + '\n');
  process.stderr.write('\n');
  state._ciStatusLine = line1;
  state._ciStatusDetail = detail || '';
}

function populateFailedJobs(state, ci, worktreeDir) {
  const initialFailedJobs = buildInitialFailedJobs(ci);
  resolveMissingRunIds(initialFailedJobs, worktreeDir);
  state._ciFailedJobs = initialFailedJobs;
  return initialFailedJobs;
}

// Surface the classifier context the infra-classifier (GH-508) depends on. Only
// fetch jobs+logs when CI is actually failing — passing/pending runs don't need
// this and we want to keep the hot loop fast.
function attachClassifierContext(state, ci, initialFailedJobs, worktreeDir) {
  state._ciStatus = mapCiStatus(ci.status);
  // Bug 542-12: stamp the freshness so infra-retry can refuse a persisted
  // _ciStatus inherited from a prior process (which could be stale).
  state._ciStatusFreshness = { pid: process.pid, at: new Date().toISOString() };
  if (ci.status === 'failing' && initialFailedJobs.length > 0) {
    const classifierCtx = fetchClassifierContext(initialFailedJobs, worktreeDir);
    state._ciAllJobs = classifierCtx.allJobs;
    state._ciFailedLogs = classifierCtx.failedLogs;
    // Bug C (GH-508): join databaseId from allJobs by name so each failed job
    // carries the per-job ID signal2 needs.
    attachJobIds(initialFailedJobs, classifierCtx.allJobs);
    // PR #542 cursor[bot]: extract failing-test file paths from the raw logs so
    // classifier signal3 has something to read.
    state._ciFailedTests = extractFailedTestPaths(classifierCtx.failedLogs);
  } else {
    state._ciAllJobs = [];
    state._ciFailedLogs = '';
    state._ciFailedTests = [];
  }
}

module.exports = function registerMonitor(register) {
  register('monitor', (state, ctx) => {
    // Stale infra-failure cache is auto-cleared by the orchestrator in
    // follow-up-next.js BEFORE any step runs (GH-536 round-2 lift). The
    // in-step call previously here is removed as dead code; `clearStaleInfraCache`
    // remains exported for direct unit-test use.

    const followUpPr = require(path.join(ctx.workScriptsDir, 'follow-up-pr.js'));
    const { getPRInfo, checkCI, getReviews, formatReport } = followUpPr;
    const prArg = state.prNumber || undefined;

    let prInfo = fetchPrInfoOrFail(state, getPRInfo, prArg);
    if (!prInfo) return null;

    const refreshed = refreshPrUntilKnown(getPRInfo, prArg, prInfo);
    prInfo = refreshed.prInfo;
    const local = detectLocalConflict(prInfo.baseBranch, ctx && ctx.worktreeDir);
    recordMergeStatus(state, prInfo, refreshed.retries, local);

    if (prInfo.state === 'MERGED') {
      writeMonitorResult(state, { exitCode: 0, output: `PR #${prInfo.number} is merged.` });
      state.currentStep = 'report';
      return null;
    }

    const ci = fetchCi(state, prInfo, checkCI, ctx.worktreeDir);
    if (!ci) return null;
    const reviews = fetchReviews(prInfo, getReviews);

    const output = buildOutput(state, prInfo, ci, reviews, formatReport);
    const exitCode = computeExitCode(prInfo, ci, reviews);
    writeMonitorResult(state, { exitCode, output: output.substring(0, 3000) });
    state._ciRunningCount = ci.running ? ci.running.length : 0;

    emitStatusLine(state, ci, reviews);
    const initialFailedJobs = populateFailedJobs(state, ci, ctx.worktreeDir);
    attachClassifierContext(state, ci, initialFailedJobs, ctx.worktreeDir);

    if (exitCode === 0) state.currentStep = computeNextStepOnGreen(state);
    return null;
  });
};

/**
 * R15 (GH-508): when CI turns green after an infra-flake rerun, route through
 * infra-retry so maybeHandleRetrySuccess can mark the pending attempt
 * `succeeded` and emit the canonical retry-success log. Otherwise proceed
 * straight to report.
 */
function computeNextStepOnGreen(state) {
  const attempts = state && state.infraRetry && state.infraRetry.attempts;
  if (Array.isArray(attempts) && attempts.length > 0) {
    const last = attempts[attempts.length - 1];
    if (last && last.outcome === 'pending') return 'infra-retry';
  }
  return 'report';
}

// test-only escape hatch — not public API. Exposes pure + shell-out helpers
// so monitor.test.js can exercise each one in isolation.
module.exports.__test__ = {
  detectLocalConflict,
  extractConflictFiles,
  refreshPrUntilKnown,
  computeExitCode,
  resolveMissingRunIds,
  buildInitialFailedJobs,
  writeMonitorResult,
  appendInitHintIfInfra,
  clearStaleInfraCache,
  mapCiStatus,
  fetchClassifierContext,
  computeNextStepOnGreen,
  extractFailedTestPaths,
};
