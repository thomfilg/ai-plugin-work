'use strict';

/**
 * Shared convention-based worktree lookup for the work-implement hooks.
 *
 * Worktrees follow the convention `<WORKTREES_BASE>/<repo>-<safeTicketId>`
 * (per inspect.js:44). Both `work-implement-enforce.js` (detectWorktreeDir)
 * and `enforce-tdd-on-stop-helpers.js` (resolveWorktreeDir) need the same
 * lookup — it lives here once so the two hooks cannot drift.
 */

const fs = require('fs');
const path = require('path');
const { worktreeDirFrom, configuredRepoName } = require(
  path.join(__dirname, '..', '..', 'lib', 'resolve-base-dirs')
);

/** True when `p` is an existing directory (never throws). */
function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve `<WORKTREES_BASE>/<repo>-<safeTicketId>` when it exists.
 *
 * The repo name is the CONFIGURED one. This used to fall back to
 * `config.REPO_NAME`, whose default is the documentation example 'my-project',
 * with the rationale that detection should not "silently fail when the
 * REPO_NAME env var is unset but worktrees exist as
 * `<base>/my-project-<TICKET>`". Nobody's worktree is called that unless they
 * were bitten by the same placeholder — probing for it can only match a
 * directory some other guess created.
 *
 * @param {string} safeTicketId - filesystem-safe ticket id
 * @returns {string|null} resolved directory path, or null when not found
 */
function conventionWorktreeDir(safeTicketId) {
  const candidate = worktreeDirFrom(process.env.WORKTREES_BASE, configuredRepoName(), safeTicketId);
  if (!candidate) return null;
  return isDirectory(candidate) ? path.resolve(candidate) : null;
}

module.exports = { isDirectory, conventionWorktreeDir };
