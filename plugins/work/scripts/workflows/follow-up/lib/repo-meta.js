/**
 * Repo-metadata helpers: default-branch detection, PR-diff file listing, and
 * owner/repo slug detection. Extracted from `follow-up-next.js` (default
 * branch + diff) and `lib/steps/report.js` (repo slug) so both share the
 * `gh repo view` → `git remote` fallback dance and the per-worktree cache key
 * convention.
 *
 * Pure module — all I/O goes through `child_process` calls scoped to the
 * supplied `worktreeDir`. Caches are module-level; tests that need a fresh
 * cache should invalidate the require cache (`delete require.cache[path]`).
 */

'use strict';

const cp = require('node:child_process');

// Shared trimmed-stdout helper used by both detectDefaultBranch and
// detectRepoSlug. Swallows non-zero exits / errors and returns '' so callers
// can fall through to their next probe.
function runQuiet(cmd, cwd) {
  try {
    return cp
      .execSync(cmd, {
        cwd,
        encoding: 'utf8',
        timeout: 8000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      .trim();
  } catch {
    return '';
  }
}

// Bug F (GH-508): hardcoding `origin/main` broke repos with non-main default
// branches (signal3 was scoring against an empty diff). Detect the actual
// default branch via `gh repo view`, fall back to `git remote show origin`,
// then to 'main'. Cached per-process — the default branch doesn't change
// during a single follow-up run.
const _detectedDefaultBranch = new Map();
function detectDefaultBranch(worktreeDir) {
  const key = worktreeDir || process.cwd();
  if (_detectedDefaultBranch.has(key)) return _detectedDefaultBranch.get(key);
  let detected = runQuiet(
    'gh repo view --json defaultBranchRef --jq .defaultBranchRef.name',
    worktreeDir
  );
  if (!detected) {
    const remote = runQuiet('git remote show origin', worktreeDir);
    const m = remote.match(/HEAD branch:\s*(\S+)/);
    if (m && m[1] && m[1] !== '(unknown)') detected = m[1];
  }
  const resolved = detected || 'main';
  _detectedDefaultBranch.set(key, resolved);
  return resolved;
}

// Compute the PR diff file list (origin/<default>...HEAD). Fails open with [].
function loadPrDiffFiles(worktreeDir) {
  const branch = detectDefaultBranch(worktreeDir);
  try {
    const out = cp.execSync(`git diff --name-only origin/${branch}...HEAD`, {
      cwd: worktreeDir,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// Bug 542-11: derive repo owner/name from git remote when state didn't carry
// them — production state never sets repoOwner/repoName, so URLs used to fall
// back to `OWNER`/`REPO` placeholders. Tries `gh repo view` first, then parses
// `git remote get-url origin`.
// Bug 542-13: cache MUST be keyed per-worktree — a single process can serve
// multiple tickets across multiple worktrees, each pointing at a different
// origin remote. The prior single-var cache leaked the first worktree's
// owner/name into every subsequent ticket's diagnostic URLs.
const _repoSlugCache = new Map();
function detectRepoSlug(worktreeDir) {
  const key = worktreeDir || process.cwd();
  if (_repoSlugCache.has(key)) return _repoSlugCache.get(key);
  const json = runQuiet('gh repo view --json owner,name', worktreeDir);
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (parsed && parsed.owner && parsed.name) {
        const slug = { owner: parsed.owner.login || parsed.owner, name: parsed.name };
        _repoSlugCache.set(key, slug);
        return slug;
      }
    } catch {
      /* fall through to git remote parse */
    }
  }
  const url = runQuiet('git remote get-url origin', worktreeDir);
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (m) {
    const slug = { owner: m[1], name: m[2] };
    _repoSlugCache.set(key, slug);
    return slug;
  }
  const empty = { owner: null, name: null };
  _repoSlugCache.set(key, empty);
  return empty;
}

module.exports = { detectDefaultBranch, loadPrDiffFiles, detectRepoSlug };
