'use strict';

/**
 * Shared `.work-state.json` reader for `/stats` and `/health` (GH-317 / R10).
 *
 * Pure-ish module: the only side effect is reading the filesystem. It does NOT
 * resolve paths (callers own their path strategy — `getStatePath` vs a manual
 * `path.join`) so the duplicated existsSync + readFileSync + JSON.parse block
 * lives in exactly one place.
 *
 * Zero runtime dependencies.
 */

const fs = require('node:fs');

/**
 * Read + parse a `.work-state.json` file, distinguishing missing from corrupt.
 *
 * @param {string|null|undefined} statePath - absolute path to the state file.
 * @returns {{ ok: true, state: object } | { ok: false, reason: 'missing'|'corrupt' }}
 *   - `missing` when `statePath` is falsy or the file does not exist.
 *   - `corrupt` when the file exists but is not valid JSON.
 */
function readStateFile(statePath) {
  if (!statePath || !fs.existsSync(statePath)) return { ok: false, reason: 'missing' };
  try {
    return { ok: true, state: JSON.parse(fs.readFileSync(statePath, 'utf8')) };
  } catch (_err) {
    return { ok: false, reason: 'corrupt' };
  }
}

module.exports = { readStateFile };
