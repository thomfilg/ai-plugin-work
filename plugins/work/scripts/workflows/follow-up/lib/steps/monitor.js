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

// Local `git merge-tree` cross-check against the PR's base branch.
// Authoritative against GitHub's false-clean cases (stacked PRs, stale cache).
function detectLocalConflict(baseBranch, worktreeDir) {
  const result = { conflicting: false, files: [] };
  if (!baseBranch || !worktreeDir) return result;
  try {
    execFileSync('git', ['fetch', 'origin', baseBranch], {
      stdio: 'ignore',
      cwd: worktreeDir,
      timeout: 30000,
    });
    const mb = execFileSync('git', ['merge-base', 'HEAD', `origin/${baseBranch}`], {
      encoding: 'utf8',
      cwd: worktreeDir,
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!mb) return result;
    const { spawnSync } = require('child_process');
    const res = spawnSync(
      'git',
      ['merge-tree', `--merge-base=${mb}`, 'HEAD', `origin/${baseBranch}`],
      { encoding: 'utf8', cwd: worktreeDir, timeout: 30000 }
    );
    const tree = (res && (res.stdout || '')) + (res && res.stderr ? res.stderr : '');
    const hasExitCode = res && res.status !== 0 && res.status !== null;
    const hasMarker = /^CONFLICT \(/m.test(tree);
    if (hasExitCode || hasMarker) {
      result.conflicting = true;
      result.files = extractConflictFiles(tree, 3);
    }
  } catch {
    /* network/auth failure → trust API */
  }
  return result;
}

function buildOutput(state, prInfo, ci, reviews, formatReport) {
  const attempt = state.attempt || 1;
  const maxAttempts = state.maxAttempts || 40;
  try {
    return formatReport(prInfo, ci, reviews, attempt, maxAttempts, {});
  } catch {
    const lines = [
      `PR: #${prInfo.number} — ${prInfo.title || ''}`,
      `CI: ${ci.status || 'unknown'}`,
    ];
    if (reviews.hasBlocking) lines.push(`Reviews: ${reviews.blocking.length} BLOCKING`);
    else if (reviews.pendingBots && reviews.pendingBots.length > 0)
      lines.push('Reviews: Awaiting bot reviews');
    else lines.push('Reviews: CLEAR');
    return lines.join('\n');
  }
}

function formatElapsed(monitorStartTime) {
  if (!monitorStartTime) return '';
  const ms = Date.now() - new Date(monitorStartTime).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function ciCountParts(ci, reviews) {
  const parts = [];
  if (ci.running && ci.running.length > 0) parts.push(`🔄 ${ci.running.length}`);
  if (ci.passed && ci.passed.length > 0) parts.push(`✅ ${ci.passed.length}`);
  if (ci.failed && ci.failed.length > 0) parts.push(`🔴 ${ci.failed.length}`);
  if (ci.cancelled && ci.cancelled.length > 0) parts.push(`⊘ ${ci.cancelled.length}`);
  const pendingBots = reviews.pendingBots || [];
  if (pendingBots.length > 0) parts.push(`🤖 ${pendingBots.length}`);
  if (reviews.hasBlocking) parts.push(`💬 ${reviews.blocking.length}`);
  return parts;
}

function ciStatusLabel(status) {
  if (status === 'passing') return '✓ CI';
  if (status === 'failing') return '✗ CI';
  if (status === 'pending') return '⏳ CI';
  return `CI:${status || '?'}`;
}

function ciDetail(ci) {
  if (ci.failed && ci.failed.length > 0) return `✗ ${ci.failed[0].name} — failed`;
  if (ci.running && ci.running.length > 0) return `⏳ ${ci.running[0].name} — running`;
  if (ci.passed && ci.passed.length > 0)
    return `✓ ${ci.passed[ci.passed.length - 1].name} — passed`;
  return '';
}

function buildStatusLine(state, ci, reviews) {
  const attempt = state.attempt || 1;
  const maxAttempts = state.maxAttempts || 40;
  const parts = ciCountParts(ci, reviews);
  const statusLabel = ciStatusLabel(ci.status);
  const detail = ciDetail(ci);
  const elapsed = formatElapsed(state._monitorStartTime);
  const counts = parts.length > 0 ? parts.join(' ╎ ') : '';
  const poll = `${attempt}/${maxAttempts}`;
  const line1 = [statusLabel, poll, elapsed, counts].filter(Boolean).join(' · ');
  return { line1, detail };
}

// Resolve missing runIds via the check-runs API at HEAD SHA. Matrix parent checks
// ("🧪 Run Integration Tests [tests]") often have no `link` in `gh pr checks`,
// so fix-ci would have nothing to fetch.
function resolveMissingRunIds(failedJobs, worktreeDir) {
  if (!failedJobs.some((j) => !j.runId && j.name)) return;
  try {
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
      cwd: worktreeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const apiOut = execFileSync(
      'gh',
      [
        'api',
        `repos/{owner}/{repo}/commits/${headSha}/check-runs`,
        '--paginate',
        '--jq',
        '.check_runs[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "cancelled" or .conclusion == "action_required" or .conclusion == "stale" or .conclusion == "startup_failure") | "\(.name)\t\(.details_url // .html_url)"',
      ],
      {
        encoding: 'utf8',
        timeout: 20000,
        cwd: worktreeDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 5 * 1024 * 1024,
        env: buildChildEnv(),
      }
    );
    const norm = (s) =>
      String(s || '')
        .replace(/\s*\[[^\]]+\]\s*$/, '')
        .trim();
    const byName = new Map();
    for (const line of apiOut.split('\n').filter(Boolean)) {
      const [name, link] = line.split('\t');
      const m = String(link || '').match(/runs\/(\d+)/);
      if (name && m) byName.set(norm(name), m[1]);
    }
    for (const j of failedJobs) {
      if (!j.runId) {
        const rid = byName.get(norm(j.name));
        if (rid) j.runId = rid;
      }
    }
  } catch {
    /* fail-open — fix-ci will surface the empty-runIds case */
  }
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
      state.lastMonitorResult = { exitCode: 2, output: 'No PR found.' };
      return null;
    }
    return prInfo;
  } catch (err) {
    state.lastMonitorResult = { exitCode: 2, output: `Error getting PR info: ${err.message}` };
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

// Order matters: read `j.url || j.link`. `checkCI()` renames `link → url` for
// failed jobs that have been normalized, but legacy/un-normalized entries
// still carry only `link`. Probing `url` first preserves the canonical name
// when present and falls back to `link` so we never drop a runId.
function buildInitialFailedJobs(ci) {
  return (ci.failed || []).map((j) => {
    const m = String(j.url || j.link || '').match(/runs\/(\d+)/);
    return { name: j.name || '', runId: m ? m[1] : null };
  });
}

module.exports = function registerMonitor(register) {
  register('monitor', (state, ctx) => {
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
      state.lastMonitorResult = { exitCode: 0, output: `PR #${prInfo.number} is merged.` };
      state.currentStep = 'report';
      return null;
    }

    let ci;
    try {
      ci = checkCI(prInfo.number);
    } catch (err) {
      state.lastMonitorResult = { exitCode: 2, output: `Error checking CI: ${err.message}` };
      return null;
    }
    if (ci.status === 'pending' && hasFailedJobs(prInfo, ctx.worktreeDir)) {
      ci.status = 'failing';
    }

    let reviews;
    try {
      reviews = getReviews(prInfo.number);
    } catch {
      reviews = emptyReviews();
    }

    const output = buildOutput(state, prInfo, ci, reviews, formatReport);
    const exitCode = computeExitCode(prInfo, ci, reviews);
    state.lastMonitorResult = { exitCode, output: output.substring(0, 3000) };
    state._ciRunningCount = ci.running ? ci.running.length : 0;

    if (!state._monitorStartTime) state._monitorStartTime = new Date().toISOString();
    const { line1, detail } = buildStatusLine(state, ci, reviews);
    process.stderr.write(line1 + '\n');
    if (detail) process.stderr.write(detail + '\n');
    process.stderr.write('\n');

    state._ciStatusLine = line1;
    state._ciStatusDetail = detail || '';
    const initialFailedJobs = buildInitialFailedJobs(ci);
    resolveMissingRunIds(initialFailedJobs, ctx.worktreeDir);
    state._ciFailedJobs = initialFailedJobs;

    if (exitCode === 0) state.currentStep = 'report';
    return null;
  });
};

// test-only escape hatch — not public API. Exposes pure + shell-out helpers
// so monitor.test.js can exercise each one in isolation.
module.exports.__test__ = {
  detectLocalConflict,
  extractConflictFiles,
  refreshPrUntilKnown,
  computeExitCode,
  resolveMissingRunIds,
  buildInitialFailedJobs,
};
