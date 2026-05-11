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

    // Check individual job conclusions via the check-runs API.
    // Matrix parent stays "in_progress" but individual shard jobs
    // get conclusion:"failure" as soon as they finish.
    const raw = execFileSync(
      'gh',
      [
        'api',
        `repos/{owner}/{repo}/commits/${headSha}/check-runs`,
        '--jq',
        '.check_runs[] | select(.conclusion == "failure") | .name',
      ],
      { encoding: 'utf8', timeout: 15000, cwd: worktreeDir, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    return raw.length > 0;
  } catch {
    return false; // fail-open
  }
}

module.exports = function registerMonitor(register) {
  register('monitor', (state, ctx) => {
    const followUpPr = require(path.join(ctx.workScriptsDir, 'follow-up-pr.js'));
    const { getPRInfo, checkCI, getReviews, formatReport } = followUpPr;

    const prArg = state.prNumber || undefined;

    let prInfo, ci, reviews;
    try {
      prInfo = getPRInfo(prArg);
    } catch (err) {
      state.lastMonitorResult = { exitCode: 2, output: `Error getting PR info: ${err.message}` };
      return null;
    }

    if (!prInfo || !prInfo.number) {
      state.lastMonitorResult = { exitCode: 2, output: 'No PR found.' };
      return null;
    }

    if (prInfo.state === 'MERGED') {
      state.lastMonitorResult = { exitCode: 0, output: `PR #${prInfo.number} is merged.` };
      state.currentStep = 'report';
      return null;
    }

    try {
      ci = checkCI(prInfo.number);
    } catch (err) {
      state.lastMonitorResult = { exitCode: 2, output: `Error checking CI: ${err.message}` };
      return null;
    }

    // Early fail-fast: gh pr checks shows matrix parent as "pending" while
    // individual shards have already failed. Check run-level conclusions.
    if (ci.status === 'pending' && hasFailedJobs(prInfo, ctx.worktreeDir)) {
      ci.status = 'failing';
    }

    try {
      reviews = getReviews(prInfo.number);
    } catch (err) {
      // Reviews are supplementary — fail-open
      reviews = {
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

    // Build the same formatted output the CLI produces
    let output = '';
    try {
      const attempt = state.attempt || 1;
      const maxAttempts = state.maxAttempts || 40;
      output = formatReport(prInfo, ci, reviews, attempt, maxAttempts, {});
    } catch {
      // Fallback: build minimal output from raw data
      const lines = [];
      lines.push(`PR: #${prInfo.number} — ${prInfo.title || ''}`);
      lines.push(`CI: ${ci.status || 'unknown'}`);
      if (reviews.hasBlocking) {
        lines.push(`Reviews: ${reviews.blocking.length} BLOCKING`);
      } else if (reviews.pendingBots && reviews.pendingBots.length > 0) {
        lines.push('Reviews: Awaiting bot reviews');
      } else {
        lines.push('Reviews: CLEAR');
      }
      output = lines.join('\n');
    }

    // Determine exit code: 0 = all clear, 1 = issues remain
    const ciOk = ci.status === 'passing' || ci.status === 'no-checks';
    const reviewsOk =
      !reviews.hasBlocking && (!reviews.pendingBots || reviews.pendingBots.length === 0);
    const exitCode = ciOk && reviewsOk ? 0 : 1;

    state.lastMonitorResult = { exitCode, output: output.substring(0, 3000) };
    state._ciRunningCount = ci.running ? ci.running.length : 0;

    // ── Compact CI status to stderr (saves context vs full report) ──
    const attempt = state.attempt || 1;
    const maxAttempts = state.maxAttempts || 40;
    const parts = [];
    if (ci.running && ci.running.length > 0) parts.push(`🔄 ${ci.running.length}`);
    if (ci.passed && ci.passed.length > 0) parts.push(`✅ ${ci.passed.length}`);
    if (ci.failed && ci.failed.length > 0) parts.push(`🔴 ${ci.failed.length}`);
    if (ci.cancelled && ci.cancelled.length > 0) parts.push(`⊘ ${ci.cancelled.length}`);
    const pendingBots = reviews.pendingBots || [];
    if (pendingBots.length > 0) parts.push(`🤖 ${pendingBots.length}`);
    if (reviews.hasBlocking) parts.push(`💬 ${reviews.blocking.length}`);

    const statusLabel =
      ci.status === 'passing'
        ? '✓ CI'
        : ci.status === 'failing'
          ? '✗ CI'
          : ci.status === 'pending'
            ? '⏳ CI'
            : `CI:${ci.status || '?'}`;

    // Most recent notable check — full status line
    let detail = '';
    if (ci.failed && ci.failed.length > 0) {
      detail = `✗ ${ci.failed[0].name} — failed`;
    } else if (ci.running && ci.running.length > 0) {
      detail = `⏳ ${ci.running[0].name} — running`;
    } else if (ci.passed && ci.passed.length > 0) {
      detail = `✓ ${ci.passed[ci.passed.length - 1].name} — passed`;
    }

    // Track when CI monitoring started (not session start)
    if (!state._monitorStartTime) state._monitorStartTime = new Date().toISOString();

    // Elapsed time since CI monitoring started
    let elapsed = '';
    if (state._monitorStartTime) {
      const ms = Date.now() - new Date(state._monitorStartTime).getTime();
      const secs = Math.floor(ms / 1000);
      if (secs < 60) elapsed = `${secs}s`;
      else if (secs < 3600) elapsed = `${Math.floor(secs / 60)}m ${secs % 60}s`;
      else elapsed = `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
    }

    const counts = parts.length > 0 ? parts.join(' ╎ ') : '';
    const time = elapsed || '';
    const poll = `${attempt}/${maxAttempts}`;
    const line1 = [statusLabel, poll, time, counts].filter(Boolean).join(' · ');
    process.stderr.write(line1 + '\n');
    if (detail) process.stderr.write(detail + '\n');
    process.stderr.write('\n');

    if (exitCode === 0) {
      state.currentStep = 'report';
    }

    return null;
  });
};
