'use strict';

/**
 * commit-msg-hook.js — shared detection for the GH-539 commit-msg validator hook.
 *
 * ONE implementation, two consumers (the validator-unification invariant):
 *   - `engine/inspect.js` sets `state.hasCommitMsgHook` (diagnostic — the commit
 *     step always commits directly now that commit-writer is removed).
 *   - `lib/hooks/enforce-agent-usage.js` lifts its direct-`git commit` block in
 *     worktrees where the validator hook is installed.
 *
 * A worktree "has the validator" when the active hooks directory contains an
 * EXECUTABLE `commit-msg` hook that delegates to `validate-commit-msg`. The
 * hooks directory is resolved exactly as the installer resolves it:
 * `core.hooksPath` when set (relative values anchored at the worktree root),
 * else `<worktree>/.git/hooks`. Fails closed (false) on any error.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Read `core.hooksPath` for the worktree, or `null` when unset. Pure `--get`.
 * @param {string} worktree
 * @returns {string|null}
 */
function readHooksPath(worktree) {
  try {
    const value = execFileSync('git', ['-C', worktree, 'config', '--get', 'core.hooksPath'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return value || null;
  } catch {
    // `git config --get` exits non-zero when the key is unset — treat as unset.
    return null;
  }
}

/**
 * Resolve the active hooks directory for a worktree (mirrors the installer).
 * @param {string} worktree
 * @returns {string}
 */
function resolveHooksDir(worktree) {
  const configured = readHooksPath(worktree);
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(worktree, configured);
  }
  return path.resolve(worktree, '.git', 'hooks');
}

/**
 * Whether an EXECUTABLE `commit-msg` hook delegating to `validate-commit-msg`
 * is installed in the worktree. The executable-bit check matters because git
 * silently skips a non-executable hook — without it a stale/non-exec file would
 * make callers believe validation runs when it does not.
 * @param {string} worktree
 * @returns {boolean}
 */
function hasCommitMsgValidator(worktree) {
  const hookFile = path.join(resolveHooksDir(worktree), 'commit-msg');
  // Open ONCE and fstat + read from the same descriptor so the mode check and
  // the content read observe the same file — no check-then-use race (CodeQL).
  let fd;
  try {
    fd = fs.openSync(hookFile, 'r');
    if ((fs.fstatSync(fd).mode & 0o111) === 0) return false; // git skips non-exec hooks
    return fs.readFileSync(fd, 'utf-8').includes('validate-commit-msg');
  } catch {
    return false; // missing / unreadable
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort close */
      }
    }
  }
}

module.exports = { hasCommitMsgValidator, resolveHooksDir, readHooksPath };
