// GENERATED — edit factories/storeMigration/lock.js and run scripts/sync-vendored.js

'use strict';

/**
 * lock — per-location mutual exclusion for a migration run.
 *
 * Several hooks, and several sessions, can fire at once. Two processes
 * relocating the same store would race on a rename, so each location is
 * guarded while its chain runs.
 *
 * The lock is an atomic `mkdir`, placed BESIDE the store rather than inside
 * it: a migration may rename the store directory itself, which would carry an
 * inside-lock away mid-run and leave it orphaned at the new path.
 *
 * A live lock means another process owns the location — the caller skips and
 * reports it, rather than waiting. A lock older than `lockTimeoutMs` is
 * treated as abandoned (a crashed process) and stolen, so one crash cannot
 * wedge a store forever.
 */

const fs = require('node:fs');
const path = require('node:path');

function lockPath(dir) {
  return path.join(path.dirname(dir), `.${path.basename(dir)}.migrating`);
}

function lockIsStale(lock, spec, now) {
  try {
    return now() - fs.statSync(lock).mtimeMs > spec.lockTimeoutMs;
  } catch {
    // Vanished between the failed mkdir and this stat — treat as free.
    return true;
  }
}

/** Atomic acquire via mkdir. Returns the lock path, or null if another process holds it. */
function acquireLock(spec, dir, now) {
  const lock = lockPath(dir);
  // The store's parent may not exist yet — the very first migration of a
  // relocated store creates it. Without this, mkdir(lock) fails ENOENT and the
  // location is misreported as held by another process, so the migration that
  // matters most never runs. Only reached once there IS something to migrate.
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
  } catch {
    /* the mkdir below reports the real problem */
  }
  try {
    fs.mkdirSync(lock, { recursive: false });
    return lock;
  } catch (err) {
    if (err.code !== 'EEXIST') return null;
    if (!lockIsStale(lock, spec, now)) return null;
    try {
      fs.rmSync(lock, { recursive: true, force: true });
      fs.mkdirSync(lock, { recursive: false });
      return lock;
    } catch {
      return null;
    }
  }
}

function releaseLock(lock) {
  try {
    fs.rmSync(lock, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

module.exports = { lockPath, acquireLock, releaseLock };
