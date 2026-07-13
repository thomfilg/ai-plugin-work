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

/**
 * Shared fail-closed guard for the destructive cleanup phases (GH-283).
 *
 * `completion_check` only protects runs that reach it via the FORWARD phase
 * order. A ticket whose persisted cleanup state was saved at `branch_cleanup`
 * or a LATER phase under the old (pre-`completion_check`) order resumes straight
 * at that saved phase and never re-enters `completion_check` — so every
 * destructive phase at/after the gate re-asserts completion evidence on entry,
 * closing the "persisted state skips the gate" bypass. This is the "re-validate
 * saved state" repair the gate demands, applied per phase rather than by
 * migrating the persisted phase pointer.
 *
 * Returns a phase BLOCK object (`{ ok:false, errors }`) when evidence is absent
 * (fail closed), or `null` when `**Status:** COMPLETE` is present so the caller
 * proceeds with its own checks.
 *
 * @param {string} tasksDir absolute path to the ticket's tasks dir
 * @param {string} phaseLabel calling phase name, surfaced in the block message
 * @returns {{ ok: false, errors: string[] }|null}
 */
function completionGateBlock(tasksDir, phaseLabel) {
  if (isCompletionComplete(tasksDir)) return null;
  return {
    ok: false,
    errors: [
      'Cannot verify ticket completion: completion.check.md does not read ' +
        `**Status:** COMPLETE. ${phaseLabel} refuses destructive cleanup without ` +
        'completion evidence — persisted cleanup state resumed past the ' +
        'completion_check gate (e.g. state saved under the old phase order). ' +
        'Repair: re-run the check step until it reports **Status:** COMPLETE, ' +
        'or restore the archived report, then re-run cleanup.',
    ],
  };
}

module.exports = { isCompletionComplete, completionGateBlock, STATUS_COMPLETE_RE, CHECK_FILE };
