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
 * Uses config.REPO_NAME as the fallback repo name (the same fallback
 * work-next.js / follow-up-next.js use when CREATING worktrees) so detection
 * does not silently fail when the REPO_NAME env var is unset but worktrees
 * exist as `<base>/my-project-<TICKET>`.
 *
 * @param {string} safeTicketId - filesystem-safe ticket id
 * @returns {string|null} resolved directory path, or null when not found
 */
function conventionWorktreeDir(safeTicketId) {
  const wbase = process.env.WORKTREES_BASE;
  let repo = process.env.REPO_NAME;
  if (!repo) {
    try {
      repo = require(path.join(__dirname, '..', '..', 'lib', 'config')).REPO_NAME;
    } catch {
      /* config unavailable — skip convention lookup */
    }
  }
  if (!wbase || !repo) return null;
  const candidate = path.join(wbase, `${repo}-${safeTicketId}`);
  return isDirectory(candidate) ? path.resolve(candidate) : null;
}

module.exports = { isDirectory, conventionWorktreeDir };
