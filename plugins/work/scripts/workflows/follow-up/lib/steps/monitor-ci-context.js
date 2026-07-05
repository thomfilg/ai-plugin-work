/**
 * monitor-ci-context.js — CI failed-job + infra-classifier context helpers.
 *
 * Extracted from monitor.js (which exceeded the file-size budget). These build
 * the `_ciFailedJobs` / `_ciAllJobs` / `_ciFailedLogs` / `_ciFailedTests`
 * signals the infra-classifier (GH-508) reads. monitor.js re-exports them via
 * its `__test__` object for backward-compatible unit access.
 */

'use strict';

const { execFileSync } = require('child_process');
const { buildChildEnv } = require('../../../work/scripts/gh-exec');

// Order matters: read `j.url || j.link`. `checkCI()` renames `link → url` for
// failed jobs that have been normalized, but legacy/un-normalized entries still
// carry only `link`. Probing `url` first preserves the canonical name when
// present and falls back to `link` so we never drop a runId.
function buildInitialFailedJobs(ci) {
  return (ci.failed || []).map((j) => {
    const m = String(j.url || j.link || '').match(/runs\/(\d+)/);
    return { name: j.name || '', runId: m ? m[1] : null };
  });
}

// GH-214: collect the unique GitHub Actions run IDs across ALL job buckets
// (running/passed/failed/cancelled/neutral) so the monitor can persist them to
// state each cycle — a later invocation (or an operator) can resume/inspect
// the same runs without re-deriving them from terminal output.
function collectRunIds(ci) {
  const ids = new Set();
  for (const bucket of ['running', 'passed', 'failed', 'cancelled', 'neutral']) {
    for (const j of ci[bucket] || []) {
      const m = String(j.url || j.link || '').match(/runs\/(\d+)/);
      if (m) ids.add(m[1]);
    }
  }
  return [...ids];
}

// Resolve missing runIds via the check-runs API at HEAD SHA. Matrix parent
// checks ("🧪 Run Integration Tests [tests]") often have no `link` in
// `gh pr checks`, so fix-ci would have nothing to fetch.
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

// Map gh pr checks status → infra-classifier `ciStatus` literal ('success' /
// 'failure' / 'in_progress'). Used by the retry-success short-circuit in
// infra-retry.js. Bug B (GH-508): production ctx must surface this.
function mapCiStatus(ciStatus) {
  if (ciStatus === 'passing' || ciStatus === 'no-checks') return 'success';
  if (ciStatus === 'failing') return 'failure';
  return 'in_progress';
}

// Fetch all jobs + failed logs for the first failed run. Conservative: only
// called when CI is failing AND we have a runId. The classifier's signal1 needs
// the full job list; signal2 needs the empty-log evidence; signal4 scans the
// aggregated raw logs. Bug B (GH-508).
function fetchClassifierContext(failedJobs, worktreeDir) {
  const out = { allJobs: [], failedLogs: '' };
  const runId = failedJobs.find((j) => j.runId)?.runId;
  if (!runId || !/^\d+$/.test(String(runId))) return out;
  try {
    const jobsRaw = execFileSync('gh', ['run', 'view', String(runId), '--json', 'jobs'], {
      encoding: 'utf8',
      timeout: 20000,
      cwd: worktreeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 5 * 1024 * 1024,
      env: buildChildEnv(),
    });
    const parsed = JSON.parse(jobsRaw || '{}');
    if (Array.isArray(parsed.jobs)) out.allJobs = parsed.jobs;
  } catch {
    /* fail-open — classifier will treat as empty */
  }
  try {
    out.failedLogs = execFileSync('gh', ['run', 'view', String(runId), '--log-failed'], {
      encoding: 'utf8',
      timeout: 30000,
      cwd: worktreeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      env: buildChildEnv(),
    });
  } catch (err) {
    out.failedLogs = (err && err.stdout) || '';
  }
  return out;
}

// Annotate each failed job with its `jobId` (gh's databaseId) by joining the
// failed-job list against the full job list by name. Bug C (GH-508): the
// infra-classifier's signal2 requires a per-job ID to call
// `gh run view <runId> --job <jobId> --log-failed`.
function indexJobsByName(allJobs) {
  const byName = new Map();
  if (!Array.isArray(allJobs)) return byName;
  for (const j of allJobs) {
    const id = j && (j.databaseId || j.id);
    if (j && j.name && id) byName.set(j.name, String(id));
  }
  return byName;
}

function attachJobIds(failedJobs, allJobs) {
  const byName = indexJobsByName(allJobs);
  if (byName.size === 0) return;
  for (const fj of failedJobs) {
    if (!fj.jobId && byName.has(fj.name)) fj.jobId = byName.get(fj.name);
  }
}

// Extract failing-test file paths from a CI log blob. Feeds the classifier's
// signal3 (unrelated failures): if none of the failing tests overlap the PR
// diff, the failure is likely infra/flake, not code the PR touched.
//
// Conservative by design — we'd rather miss a path than hallucinate one and
// poison signal3. Recognised shapes:
//   - vitest/jest:  `FAIL <path>.test.ts` or `FAIL <path>.spec.tsx (…)`
//   - playwright:   `  × <path>.spec.ts:LINE:COL › …` (also `✘`, `✕`)
//   - generic:      any line containing `FAIL|×|✘|✕|failed` plus a
//                   `(plugins|apps|packages|src|tests)/.*\.(test|spec)\.[jt]sx?`
//                   substring.
const TEST_PATH_RE =
  /\b((?:plugins|apps|packages|src|tests|test|e2e)\/[\w./@-]+?\.(?:test|spec)\.[jt]sx?)\b/g;
const FAIL_MARKER_RE = /\b(FAIL|failed)\b|[×✘✕]/;

function extractFailedTestPaths(rawLogs) {
  if (typeof rawLogs !== 'string' || rawLogs.length === 0) return [];
  const seen = new Set();
  for (const line of rawLogs.split('\n')) {
    if (!FAIL_MARKER_RE.test(line)) continue;
    let m;
    TEST_PATH_RE.lastIndex = 0;
    while ((m = TEST_PATH_RE.exec(line)) !== null) {
      const p = m[1];
      if (p.startsWith('/')) continue;
      seen.add(p);
    }
  }
  return Array.from(seen);
}

module.exports = {
  buildInitialFailedJobs,
  collectRunIds,
  resolveMissingRunIds,
  mapCiStatus,
  fetchClassifierContext,
  indexJobsByName,
  attachJobIds,
  extractFailedTestPaths,
};
