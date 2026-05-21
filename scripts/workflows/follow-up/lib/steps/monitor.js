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

    // GitHub returns `mergeable: UNKNOWN` for up to ~30s after a push or a
    // sibling-PR merge, while it recomputes mergeability. If we accept that
    // value we declare the PR conflict-free when in fact a conflict is about
    // to be reported. Retry a few times before trusting UNKNOWN.
    // Bounded retry (3 * 3s = 9s max latency) — better than letting a
    // conflict slip past the gate for an entire cycle.
    // Synchronous sleep via Atomics.wait — no subprocess, no event-loop
    // dependency. Uses a private SharedArrayBuffer so the wait can never be
    // notified externally; it always times out after `ms` milliseconds.
    const sleepSync = (ms) => {
      try {
        const sab = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(sab), 0, 0, ms);
      } catch {
        /* sleep best-effort */
      }
    };

    let mergeableRetries = 0;
    while (prInfo && prInfo.mergeable === 'UNKNOWN' && mergeableRetries < 3) {
      mergeableRetries++;
      sleepSync(3000);
      try {
        prInfo = getPRInfo(prArg);
      } catch {
        break;
      }
    }

    // First-class conflict signal. Any later step (triage, fix-reviews,
    // report) can check `state._isConflicting` without re-parsing the
    // formatted output. This makes merge-conflict detection authoritative:
    // it preempts CI status, review state, and pending bot reviews.
    const apiConflicting =
      prInfo.mergeable === 'CONFLICTING' || prInfo.mergeStateStatus === 'DIRTY';

    // Cross-check via local `git merge-tree` against the PR's base branch.
    // GitHub's `mergeable` API has known false-clean cases:
    //   - stacked PRs (base is a sibling branch — clean to base, conflicts vs main)
    //   - stale cached mergeability after a sibling PR merged into the base
    // Local check is authoritative because it operates on actual tree content.
    // Best-effort: if `git fetch` / `git merge-tree` fail, trust the API answer.
    let localConflicting = false;
    let localConflictFiles = [];
    const baseBranch = prInfo.baseBranch;
    if (baseBranch && ctx && ctx.worktreeDir) {
      try {
        execFileSync('git', ['fetch', 'origin', baseBranch], {
          stdio: 'ignore',
          cwd: ctx.worktreeDir,
          timeout: 30000,
        });
        const mb = execFileSync('git', ['merge-base', 'HEAD', `origin/${baseBranch}`], {
          encoding: 'utf8',
          cwd: ctx.worktreeDir,
          timeout: 10000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (mb) {
          // `git merge-tree` exits with code 1 when conflicts are present —
          // execFileSync THROWS on non-zero, so we use spawnSync to capture
          // both stdout and exit code without throwing. Conflict markers in
          // the default output format are `CONFLICT (content): ...` lines
          // (NOT `<<<<<<<` separator markers — those only appear with
          // --write-tree mode against an actual workdir, not against bare
          // refs like origin/<base>). Each conflicting file gets one
          // `Auto-merging <path>` and one `CONFLICT (...) <path>` line.
          const { spawnSync } = require('child_process');
          const res = spawnSync(
            'git',
            ['merge-tree', `--merge-base=${mb}`, 'HEAD', `origin/${baseBranch}`],
            {
              encoding: 'utf8',
              cwd: ctx.worktreeDir,
              timeout: 30000,
            }
          );
          const tree = (res && (res.stdout || '')) + (res && res.stderr ? res.stderr : '');
          // Conflict is signaled by EITHER non-zero exit code OR a CONFLICT line.
          const hasConflictExitCode = res && res.status !== 0 && res.status !== null;
          const hasConflictMarker = /^CONFLICT \(/m.test(tree);
          if (hasConflictExitCode || hasConflictMarker) {
            localConflicting = true;
            // Extract conflicting file paths from `CONFLICT (...): Merge conflict in <path>`
            // and `Auto-merging <path>` lines.
            for (const line of tree.split('\n')) {
              const m =
                line.match(/^CONFLICT \([^)]+\):.*?(?:in|on) (.+?)$/) ||
                line.match(/^Auto-merging (.+?)$/);
              if (m && !localConflictFiles.includes(m[1])) {
                localConflictFiles.push(m[1]);
              }
              if (localConflictFiles.length >= 3) break;
            }
          }
        }
      } catch {
        /* network/auth failure → trust API */
      }
    }

    state._mergeStatus = {
      mergeable: prInfo.mergeable || 'UNKNOWN',
      mergeStateStatus: prInfo.mergeStateStatus || 'UNKNOWN',
      baseBranch: baseBranch || null,
      apiConflicting,
      localConflicting,
      localConflictFiles,
      isConflicting: apiConflicting || localConflicting,
      retries: mergeableRetries,
    };
    state._isConflicting = state._mergeStatus.isConflicting;

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

    // Determine exit code: 0 = all clear, 1 = issues remain.
    // Merge state matters: a PR with green CI + clear reviews but
    // `mergeable: CONFLICTING` is NOT all-clear — it needs a rebase before
    // it can merge. Previously this returned 0 and `report.js` declared the
    // workflow complete while conflicts existed on the PR.
    const ciOk = ci.status === 'passing' || ci.status === 'no-checks';
    const reviewsOk =
      !reviews.hasBlocking && (!reviews.pendingBots || reviews.pendingBots.length === 0);
    const mergeOk = prInfo.mergeable !== 'CONFLICTING' && prInfo.mergeStateStatus !== 'DIRTY';
    const exitCode = ciOk && reviewsOk && mergeOk ? 0 : 1;

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

    // Persist for fix-ci.js — header line + structured failed-job list
    // (avoids the brittle "✗ Name — failed" regex extraction).
    state._ciStatusLine = line1;
    state._ciStatusDetail = detail || '';
    const initialFailedJobs = (ci.failed || []).map((j) => {
      const m = String(j.link || '').match(/runs\/(\d+)/);
      return { name: j.name || '', runId: m ? m[1] : null };
    });

    // Resolve missing runIds via the check-runs API at HEAD SHA. Matrix
    // parent checks ("🧪 Run Integration Tests [tests]") often have no
    // `link` in `gh pr checks`, so fix-ci would have nothing to fetch.
    const needsResolve = initialFailedJobs.some((j) => !j.runId && j.name);
    if (needsResolve) {
      try {
        const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
          timeout: 5000,
          cwd: ctx.worktreeDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const apiOut = execFileSync(
          'gh',
          [
            'api',
            `repos/{owner}/{repo}/commits/${headSha}/check-runs`,
            '--paginate',
            '--jq',
            '.check_runs[] | select(.conclusion == "failure") | "\(.name)\t\(.details_url // .html_url)"',
          ],
          {
            encoding: 'utf8',
            timeout: 20000,
            cwd: ctx.worktreeDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: 5 * 1024 * 1024,
            env: buildChildEnv(),
          }
        );
        // Map normalized job name → runId (strip trailing `[tag]` suffix
        // so "🧪 Run Integration Tests" matches "🧪 Run Integration Tests")
        const byName = new Map();
        const norm = (s) =>
          String(s || '')
            .replace(/\s*\[[^\]]+\]\s*$/, '')
            .trim();
        for (const line of apiOut.split('\n').filter(Boolean)) {
          const [name, link] = line.split('\t');
          const m = String(link || '').match(/runs\/(\d+)/);
          if (name && m) byName.set(norm(name), m[1]);
        }
        for (const j of initialFailedJobs) {
          if (!j.runId) {
            const rid = byName.get(norm(j.name));
            if (rid) j.runId = rid;
          }
        }
      } catch {
        /* fail-open — fix-ci will surface the empty-runIds case */
      }
    }
    state._ciFailedJobs = initialFailedJobs;

    if (exitCode === 0) {
      state.currentStep = 'report';
    }

    return null;
  });
};
