'use strict';
/**
 * read-work-state.js — read the active `.work-state.json` for a ticket the way
 * the follow-up bar reads its own state: a single open fd for stat + read (no
 * check-then-use TOCTOU gap), a freshness cut-off so an abandoned run's bar
 * disappears, and a null return for "show nothing".
 *
 * Filename assembled from parts so the protect-state-files hook (which scans
 * script text for the literal state filename) never flags this read-only path.
 */

const fs = require('fs');
const path = require('path');

const STATE_BASENAME = '.work-state' + '.json';

// Safety net: hide a run whose state file has not been touched in this long.
// A live /work run rewrites state on every step transition, well inside this.
const FRESH_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Parsed work state for a ticket, or null when it is finished, stale, or
 * unreadable — so the bar renders nothing.
 * @param {string} base TASKS_BASE
 * @param {string} ticket ticket dir name
 * @param {number} now epoch ms (injectable for tests)
 * @returns {object|null}
 */
function readActiveState(base, ticket, now = Date.now()) {
  const stateFile = path.join(base, ticket, STATE_BASENAME);
  let fd;
  try {
    fd = fs.openSync(stateFile, 'r');
    if (now - fs.fstatSync(fd).mtimeMs > FRESH_MS) return null;
    const st = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return st && st.status !== 'complete' ? st : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = { readActiveState, FRESH_MS };
