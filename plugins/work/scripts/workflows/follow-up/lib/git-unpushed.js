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

// True when there are commits ahead of upstream. Falls back to a porcelain
// dirty-tree check when there's no upstream (or git errors).
function hasUnpushedCommits(worktreeDir) {
  const opts = {
    encoding: 'utf8',
    timeout: 5000,
    cwd: worktreeDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  try {
    const count = execFileSync('git', ['rev-list', '--count', '@{upstream}..HEAD'], opts).trim();
    return parseInt(count, 10) > 0;
  } catch {
    // No upstream or git error — check for uncommitted changes as fallback
    try {
      return execFileSync('git', ['status', '--porcelain'], opts).trim().length > 0;
    } catch {
      return false;
    }
  }
}

module.exports = { hasUnpushedCommits };
