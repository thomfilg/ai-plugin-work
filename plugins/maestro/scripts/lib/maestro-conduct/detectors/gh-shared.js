/**
 * detectors/gh-shared.js
 *
 * Shared `gh` + `git` helpers for PR-aware detectors (pr-comments, pr-status).
 * Extracted to deduplicate the spawn / repo-derivation / pr-lookup block that
 * was copy-pasted across detector files.
 */
const { spawnSync } = require('child_process');

function spawnOut(cmd, args) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
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

/**
 * Look up the open PR for `<ticket>-maestro` on the resolved repo. Returns
 * the PR number or null when no open PR exists / lookup fails.
 */
function prNumberFor(ticket, worktree) {
  const repo = repoSlug(worktree);
  if (!repo) return null;
  const json = spawnOut('gh', [
    'pr',
    'list',
    '--repo',
    repo,
    '--head',
    `${ticket}-maestro`,
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
    return arr[0] && arr[0].number;
  } catch {
    return null;
  }
}

module.exports = { spawnOut, gitOut, headSha, deriveRepo, repoSlug, prNumberFor };
