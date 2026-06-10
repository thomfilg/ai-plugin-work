'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
  return path.join(cacheDir(home), `${sessionId}.json`);
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

module.exports = { write, read, delete: del, pruneStale };
