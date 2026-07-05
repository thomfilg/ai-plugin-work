/**
 * git-unpushed.js — shared "does this worktree have unpushed work?" probe.
 *
 * Used by push-retry (to decide whether to dispatch a push) and by
 * fix-reviews (to route through push-retry when review-fix commits exist —
 * previously the skipped>0 path jumped straight to report and left the fix
 * commits unpushed).
 */

'use strict';

const { execFileSync } = require('child_process');

function gitOpts(worktreeDir) {
  return {
    encoding: 'utf8',
    timeout: 5000,
    cwd: worktreeDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
}

// STRICT probe: true only when commits exist ahead of upstream. No upstream
// or git error → false. Used by the fix-reviews done-path, where the
// dirty-tree fallback below would misroute: a stray untracked file (with no
// upstream configured) would send done→push-retry every cycle, incrementing
// _pushRetryCount to the 40-cap "Max push-retry cycles" block.
function hasUnpushedCommitsStrict(worktreeDir) {
  try {
    const count = execFileSync(
      'git',
      ['rev-list', '--count', '@{upstream}..HEAD'],
      gitOpts(worktreeDir)
    ).trim();
    return parseInt(count, 10) > 0;
  } catch {
    return false;
  }
}

// True when there are commits ahead of upstream. Falls back to a porcelain
// dirty-tree check when there's no upstream (or git errors) — push-retry's
// entry check wants "is there plausibly something to push", where a false
// positive only costs a no-op `git push`.
function hasUnpushedCommits(worktreeDir) {
  try {
    const count = execFileSync(
      'git',
      ['rev-list', '--count', '@{upstream}..HEAD'],
      gitOpts(worktreeDir)
    ).trim();
    return parseInt(count, 10) > 0;
  } catch {
    // No upstream or git error — check for uncommitted changes as fallback
    try {
      return execFileSync('git', ['status', '--porcelain'], gitOpts(worktreeDir)).trim().length > 0;
    } catch {
      return false;
    }
  }
}

module.exports = { hasUnpushedCommits, hasUnpushedCommitsStrict };
