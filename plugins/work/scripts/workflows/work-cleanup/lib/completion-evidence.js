/**
 * completion-evidence.js — shared completion-gate marker test.
 *
 * Cleanup is destructive (branch/worktree/tmux teardown), so every phase that
 * gates on completion evidence must agree on ONE canonical, fail-closed test.
 *
 * `isCompletionComplete(tasksDir)` returns true IFF `<tasksDir>/completion.check.md`
 * exists, is readable, and contains the canonical machine-readable line
 * `**Status:** COMPLETE`. It fails CLOSED (returns false) on a missing,
 * unreadable, or unresolvable path, or a present-but-wrong/absent status line.
 *
 * The STATUS_COMPLETE_RE is the single source of truth for the marker: it is
 * intentionally STRICT — the alias-resolving `validateCheckReportStatus` would
 * accept `APPROVED` / `NOT_APPLICABLE`, but destructive cleanup requires the
 * exact `**Status:** COMPLETE` marker.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CHECK_FILE = 'completion.check.md';

// Strict, canonical-only status matcher. Intentionally rejects the `APPROVED`
// and `NOT_APPLICABLE` aliases that `validateCheckReportStatus` would accept.
const STATUS_COMPLETE_RE = /^\s*\*\*Status:\*\*\s*COMPLETE\b/im;

/**
 * @param {string} tasksDir absolute path to the ticket's tasks dir
 * @returns {boolean} true iff completion.check.md reads `**Status:** COMPLETE`
 */
function isCompletionComplete(tasksDir) {
  let checkPath;
  try {
    checkPath = path.join(tasksDir, CHECK_FILE);
  } catch {
    return false;
  }
  let contents;
  try {
    contents = fs.readFileSync(checkPath, 'utf8');
  } catch {
    return false;
  }
  return STATUS_COMPLETE_RE.test(contents);
}

module.exports = { isCompletionComplete, STATUS_COMPLETE_RE, CHECK_FILE };
