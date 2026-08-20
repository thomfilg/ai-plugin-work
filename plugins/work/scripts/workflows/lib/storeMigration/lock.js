// GENERATED — edit factories/storeMigration/lock.js and run scripts/sync-vendored.js

'use strict';

/**
 * lock — atomic create-if-not-exists file locks with a pluggable staleness
 * policy.
 *
 * Three subsystems in this repo need the same primitive and had grown three
 * implementations of it: the migration runner (guard a store while its chain
 * runs), the maestro conductor (one daemon per namespace), and work-workflow's
 * task claims (one owner per task). All three are "create exclusively, inspect
 * the holder, reclaim or refuse, release". Only three things actually differed,
 * so those are the config:
 *
 *   - WHERE the lock file sits, relative to the thing being guarded
 *     (`lockPathFor`) — beside a store, at a fixed namespace path, under a
 *     `.claims/` dir.
 *   - WHEN a holder stops counting (`staleAfterMs` by mtime, and/or
 *     `isHolderDead(payload)` by liveness). Neither set ⇒ a lock is held until
 *     released, which is what a task claim wants.
 *   - WHETHER a caller may take over a live lock (`force` at acquire time).
 *
 * Everything else is invariant and lives here once:
 *
 * ATOMICITY. `open(…, 'wx')` is O_CREAT|O_EXCL — exactly one concurrent caller
 * can win. This closes the read-then-write TOCTOU window that a naive
 * `existsSync` check leaves open, which is the bug that lets two holders both
 * believe they own the lock.
 *
 * BOUNDED RETRY. Reclaiming means unlink-then-recreate, and the recreate can
 * lose to a third process. Retry a few times, then fail closed rather than
 * loop — refusing is always safe, double-holding never is.
 *
 * PAYLOAD. The lock body is JSON, so a holder can record who it is (pid, host,
 * owner id). `isHolderDead` reads it. A body that will not parse is treated as
 * an unreadable holder: refused unless forced, because guessing about a lock
 * you cannot read is how you get two writers.
 *
 * RELEASE IS OWNERSHIP-CHECKED. `release` only removes a lock whose payload
 * still matches, so a process that lost its lock to a takeover cannot delete
 * the new holder's on its way out.
 *
 * Directory locks created by earlier versions are removed correctly on
 * takeover (`rm -r`), so upgrading in place does not wedge on one.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_RETRIES = 5;
const DEFAULT_MODE = 0o600;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parsed lock body, or null when absent/unreadable. */
function readLock(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomic create. True on win, false when someone already holds it. */
function createExclusive(file, body, mode) {
  let fd;
  try {
    fd = fs.openSync(file, 'wx', mode);
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'EISDIR') return false;
    throw err;
  }
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

// `recursive` so a directory lock left by an older release is cleared too.
function removeLock(file) {
  try {
    fs.rmSync(file, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function agedOut(file, staleAfterMs, now) {
  if (typeof staleAfterMs !== 'number') return false;
  try {
    return now() - fs.statSync(file).mtimeMs > staleAfterMs;
  } catch {
    // Vanished between the failed create and this stat — treat as free.
    return true;
  }
}

function optionalFunction(cfg, key) {
  const value = cfg[key];
  if (value === undefined) return null;
  if (typeof value !== 'function') throw new TypeError(`lock: "${key}" must be a function`);
  return value;
}

function optionalPositiveMs(cfg, key) {
  const value = cfg[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || value <= 0) {
    throw new TypeError(`lock: "${key}" must be a positive number or null`);
  }
  return value;
}

function intOr(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function assertConfig(config) {
  const cfg = isPlainObject(config) ? config : {};
  return Object.freeze({
    lockPathFor: optionalFunction(cfg, 'lockPathFor') || ((target) => `${target}.lock`),
    isHolderDead: optionalFunction(cfg, 'isHolderDead'),
    staleAfterMs: optionalPositiveMs(cfg, 'staleAfterMs'),
    retries: intOr(cfg.retries, DEFAULT_RETRIES),
    mode: Number.isInteger(cfg.mode) ? cfg.mode : DEFAULT_MODE,
    // Explicit so the parent of a lock holding pid/host/owner never depends
    // on the caller's umask. undefined ⇒ inherit the platform default.
    dirMode: Number.isInteger(cfg.dirMode) ? cfg.dirMode : undefined,
  });
}

/**
 * What to do about an existing lock this attempt:
 *   { refuse, held }   — someone live holds it (or it is unreadable) and we
 *                        are not forcing
 *   { takeover, forced } — stale, dead, or forced: remove it and retry
 */
function evaluateHolder(spec, file, force, now) {
  const held = readLock(file);
  const unreadable = held === null;
  const dead = !unreadable && spec.isHolderDead ? spec.isHolderDead(held) : false;
  const stale = agedOut(file, spec.staleAfterMs, now);

  if (dead || stale) return { takeover: true, forced: false, held };
  if (force) return { takeover: true, forced: true, held };
  return { refuse: true, held: held || { unreadable: true } };
}

// The parent may not exist yet — a migration relocating a store creates it.
// Without this, create fails ENOENT and the caller misreads "nobody could hold
// this" as "somebody does".
function ensureParent(file, dirMode) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: dirMode });
  } catch {
    /* the create below reports the real problem */
  }
}

// Create, or decide about the holder and retry. Bounded: a reclaim can lose
// its recreate to a third process, and refusing is always safe where
// double-holding never is.
function claimLoop(spec, clock, { file, payload, body, force }) {
  let forced = false;
  for (let attempt = 0; attempt < spec.retries; attempt += 1) {
    if (createExclusive(file, body, spec.mode)) return { ok: true, path: file, payload, forced };
    const verdict = evaluateHolder(spec, file, force, clock);
    if (verdict.refuse) return { ok: false, path: file, held: verdict.held };
    if (verdict.forced) forced = true;
    removeLock(file);
  }
  return { ok: false, path: file, held: readLock(file) || { unreadable: true } };
}

function createFileLock(config) {
  const spec = assertConfig(config);
  const clock = typeof (config && config.now) === 'function' ? config.now : () => Date.now();

  /**
   * Claim the lock for `target`.
   * @returns {{ok: boolean, path: string, payload?: object, held?: object, forced?: boolean}}
   */
  function acquire(target, opts = {}) {
    const file = spec.lockPathFor(target);
    const payload = isPlainObject(opts.payload) ? opts.payload : {};
    ensureParent(file, spec.dirMode);
    return claimLoop(spec, clock, {
      file,
      payload,
      body: JSON.stringify(payload),
      force: Boolean(opts.force),
    });
  }

  /**
   * Release the lock for `target`. When `ownedBy` is given, the lock is only
   * removed if its payload still matches — a process that was forced out must
   * not delete the new holder's lock.
   */
  function release(target, opts = {}) {
    const file = spec.lockPathFor(target);
    if (typeof opts.ownedBy === 'function') {
      const held = readLock(file);
      if (!held || !opts.ownedBy(held)) return false;
    }
    removeLock(file);
    return true;
  }

  return Object.freeze({
    lockPathFor: spec.lockPathFor,
    read: (target) => readLock(spec.lockPathFor(target)),
    acquire,
    release,
  });
}

module.exports = { createFileLock, readLock };
