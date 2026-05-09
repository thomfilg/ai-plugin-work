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
function hasFailedRuns(prInfo, worktreeDir) {
  try {
    const branch = prInfo.headRefName || prInfo.branch || '';
    if (!branch) return false;
    const raw = execFileSync(
      'gh',
      ['run', 'list', '--branch', branch, '--limit', '10', '--json', 'conclusion,status,name'],
      { encoding: 'utf8', timeout: 10000, cwd: worktreeDir, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const runs = JSON.parse(raw);
    return runs.some((r) => r.conclusion === 'failure');
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
    if (ci.status === 'pending' && hasFailedRuns(prInfo, ctx.worktreeDir)) {
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

    // ── Compact CI status to stderr (saves context vs full report) ──
    const attempt = state.attempt || 1;
    const maxAttempts = state.maxAttempts || 40;
    const parts = [];
    if (ci.running && ci.running.length > 0) parts.push(`${ci.running.length} running`);
    if (ci.passed && ci.passed.length > 0) parts.push(`${ci.passed.length} passed`);
    if (ci.failed && ci.failed.length > 0) parts.push(`${ci.failed.length} failed`);
    if (ci.cancelled && ci.cancelled.length > 0) parts.push(`${ci.cancelled.length} cancelled`);
    const pendingBots = reviews.pendingBots || [];
    if (pendingBots.length > 0) parts.push(`${pendingBots.length} bot reviews pending`);
    if (reviews.hasBlocking) parts.push(`${reviews.blocking.length} blocking reviews`);

    const statusLabel =
      ci.status === 'passing'
        ? 'CI passed'
        : ci.status === 'failing'
          ? 'CI FAILING'
          : ci.status === 'pending'
            ? 'CI running'
            : `CI: ${ci.status || 'unknown'}`;

    // Find most recent notable check for the detail line
    let detailLine = '';
    if (ci.failed && ci.failed.length > 0) {
      detailLine = `  ✗ ${ci.failed[0].name} — failed`;
    } else if (ci.running && ci.running.length > 0) {
      detailLine = `  ⏳ ${ci.running[0].name} — running`;
    } else if (ci.passed && ci.passed.length > 0) {
      const last = ci.passed[ci.passed.length - 1];
      detailLine = `  ✓ ${last.name} — passed`;
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

    const header = elapsed
      ? `${statusLabel} (${attempt}/${maxAttempts}) · ${elapsed}`
      : `${statusLabel} (${attempt}/${maxAttempts})`;
    const lines = [header];
    if (parts.length > 0) lines.push(parts.join(' · '));
    if (detailLine) lines.push(detailLine);

    // Redraw: move cursor up to overwrite previous status block
    const prevLines = state._statusLineCount || 0;
    if (prevLines > 0) {
      process.stderr.write(`\x1b[${prevLines}A\x1b[J`);
    }
    state._statusLineCount = lines.length;
    process.stderr.write(lines.join('\n') + '\n');

    if (exitCode === 0) {
      state.currentStep = 'report';
    }

    return null;
  });
};
