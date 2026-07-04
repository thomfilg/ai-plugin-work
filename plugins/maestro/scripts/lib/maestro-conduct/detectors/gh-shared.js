/**
 * detectors/gh-shared.js
 *
 * Shared `gh` + `git` helpers for PR-aware detectors (pr-comments, pr-status).
 * Extracted to deduplicate the spawn / repo-derivation / pr-lookup block that
 * was copy-pasted across detector files.
 */
const { spawnSync } = require('child_process');

// Hard wall-clock cap on every gh/git subprocess. These run INSIDE the
// synchronous conductor tick, for every session, every TICK_SEC — a single
// hung `gh` call (network stall, credential prompt) with no timeout freezes
// the entire daemon: no question alerts, no restarts, nothing, while the
// fleet runs unwatched.
const GH_CALL_TIMEOUT_MS = parseInt(process.env.GH_CALL_TIMEOUT_MS || '15000', 10);

function spawnOut(cmd, args) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GH_CALL_TIMEOUT_MS,
  });
  return res.status === 0 ? res.stdout || '' : '';
}

function gitOut(worktree, args) {
  return spawnOut('git', ['-C', worktree, ...args]).trim();
}

function headSha(worktree) {
  return gitOut(worktree, ['rev-parse', 'HEAD']);
}

function deriveRepo(worktree) {
  const url = gitOut(worktree || '.', ['remote', 'get-url', 'origin']);
  if (!url) return '';
  // Match owner/repo from https://github.com/owner/repo(.git) or git@github.com:owner/repo(.git)
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : '';
}

function repoSlug(worktree) {
  return process.env.GITHUB_REPO || deriveRepo(worktree);
}

function prNumberForBranch(repo, branch) {
  if (!branch) return null;
  const json = spawnOut('gh', [
    'pr',
    'list',
    '--repo',
    repo,
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number',
    '--limit',
    '1',
  ]);
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    return (arr[0] && arr[0].number) || null;
  } catch {
    return null;
  }
}

/**
 * Look up the open PR for a ticket. The worktree's CHECKED-OUT branch is the
 * authoritative head (exact match — never a fuzzy `--search`, which has
 * mis-matched another ticket's PR and reaped the wrong agent); the historical
 * `<ticket>-maestro` name is the fallback for worktrees that moved off their
 * original branch. Some remotes reject `*-maestro` branch names entirely, so
 * agents push under repo-convention names — branch-blind detection was why
 * live PRs showed `0 pr-pending` heartbeats.
 * Returns the PR number or null when no open PR exists / lookup fails.
 */
function prNumberFor(ticket, worktree) {
  const repo = repoSlug(worktree);
  if (!repo) return null;
  const currentBranch = gitOut(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (currentBranch && currentBranch !== 'HEAD') {
    const hit = prNumberForBranch(repo, currentBranch);
    if (hit) return hit;
    if (currentBranch === `${ticket}-maestro`) return null; // already checked
  }
  return prNumberForBranch(repo, `${ticket}-maestro`);
}

module.exports = { spawnOut, gitOut, headSha, deriveRepo, repoSlug, prNumberFor };
