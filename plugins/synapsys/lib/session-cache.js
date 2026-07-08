'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { sanitizeSessionId } = require('./session-id');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Resolve the synapsys cache directory under the given home.
 *
 * @param {string} home
 * @returns {string}
 */
function cacheDir(home) {
  return path.join(home, '.claude', 'synapsys', '.cache');
}

/**
 * Resolve the JSON cache file path for a session id.
 *
 * @param {string} home
 * @param {string} sessionId
 * @returns {string}
 */
function cacheFile(home, sessionId) {
  // Sanitize before embedding in the path: an id containing `..` or path
  // separators would otherwise escape the cache directory via path.join.
  // `sanitizeSessionId` passes safe ids through unchanged and hashes unsafe
  // ones, so write/read stay consistent for a given id. Defense-in-depth —
  // callers now resolve via injectLedger.resolveSessionId (already sanitized).
  const safe = sanitizeSessionId(sessionId) || 'default';
  return path.join(cacheDir(home), `${safe}.json`);
}

/**
 * Persist `data` as the cache for `sessionId`. Lazily creates the cache
 * directory and writes the file with mode 0o600 (owner read/write only).
 *
 * @param {string} sessionId
 * @param {unknown} data
 * @param {{ home: string }} opts
 */
function write(sessionId, data, { home } = {}) {
  const dir = cacheDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = cacheFile(home, sessionId);
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  // Ensure mode even when the file pre-existed (writeFileSync mode only
  // applies on creation).
  fs.chmodSync(file, 0o600);
}

/**
 * Atomically claim the cache slot for `sessionId`: create the file with the
 * `wx` flag (create-or-fail) so exactly one caller wins under concurrency.
 * Returns true when THIS call created the file, false when it already existed
 * (EEXIST). Any other fs error rethrows to the caller's fail-open handler.
 * Used by the single-consume sentinel to close the check-then-act TOCTOU
 * window (two concurrent first-prompt consumes can't both claim Phase 1).
 *
 * @param {string} sessionId
 * @param {unknown} data
 * @param {{ home: string }} opts
 * @returns {boolean}
 */
function claim(sessionId, data, { home } = {}) {
  const dir = cacheDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = cacheFile(home, sessionId);
  try {
    fs.writeFileSync(file, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Read and parse the cache for `sessionId`. Returns null when the file is
 * absent or cannot be parsed.
 *
 * @param {string} sessionId
 * @param {{ home: string }} opts
 * @returns {unknown|null}
 */
function read(sessionId, { home } = {}) {
  const file = cacheFile(home, sessionId);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Remove the cache file for `sessionId`. Idempotent: no-op when absent.
 *
 * @param {string} sessionId
 * @param {{ home: string }} opts
 */
function del(sessionId, { home } = {}) {
  fs.rmSync(cacheFile(home, sessionId), { force: true });
}

/**
 * Remove cache files whose last modification time is older than 7 days
 * relative to `now`. Idempotent: no-op when the cache directory is absent.
 *
 * @param {{ home: string, now?: number }} opts
 */
function pruneStale({ home, now = Date.now() } = {}) {
  const dir = cacheDir(home);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry);
    try {
      const { mtimeMs } = fs.statSync(file);
      if (now - mtimeMs > SEVEN_DAYS_MS) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // Skip files we cannot stat/remove.
    }
  }
}

module.exports = { write, claim, read, delete: del, pruneStale };
