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
 * ATOMICITY. The body is written to a private temp file and published with
 * `link(2)`, which creates the lock path or fails EEXIST — never clobbers.
 * Exactly one concurrent caller can win, which closes the read-then-write
 * TOCTOU window that a naive `existsSync` check leaves open, and what appears
 * at the lock path is always a COMPLETE lock (see `createExclusive`).
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
 *
 * KNOWN LIMIT — reclaiming a stale lock is not fully atomic. Removing one is
 * "read it, confirm it is still the one we judged, unlink it", and on a plain
 * filesystem the confirm and the unlink are separate syscalls. Two processes
 * reclaiming the same stale lock can both confirm before either unlinks, and
 * the second unlink then lands on the first one's brand-new lock, leaving both
 * believing they hold it.
 *
 * Every read here is therefore collapsed to ONE `readFileSync` whose bytes
 * answer both "who holds it" and "is it still the same file", which is as
 * tight as the gap gets: the remaining window is a single read→unlink pair.
 * Closing it entirely needs a second lock to serialize reclaims, and that lock
 * has the same problem one level down — the recursion gets rarer, it does not
 * bottom out. Advisory file locks cannot do better without kernel help
 * (`flock`, unavailable in Node core) or holder-side compromise detection.
 *
 * What this is NOT is a regression: the three implementations replaced here
 * all unlinked the incumbent unconditionally, with no identity check at all.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Written into every lock body so one holder's file is never byte-identical
// to another's. Inode identity is NOT usable here: deleting and immediately
// recreating a file in the same directory reliably reuses the inode, so
// dev:ino cannot tell "still the lock I judged" from "already replaced".
const NONCE_KEY = '__lockNonce';

const DEFAULT_RETRIES = 5;
const DEFAULT_MODE = 0o600;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Raw bytes at `file`, or null when it is absent or cannot be read. */
function readRaw(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Lock body from already-read bytes, minus the internal nonce. */
function parseLock(raw) {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return null;
    const { [NONCE_KEY]: _nonce, ...payload } = parsed;
    return payload;
  } catch {
    return null;
  }
}

/** Parsed lock body without the internal nonce, or null when absent/unreadable. */
function readLock(file) {
  return parseLock(readRaw(file));
}

// Remove one of our own private temp files. Never called on a lock path, so it
// can never take a lock away from anyone.
function discardTemp(tmp) {
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* best-effort: an orphaned temp is litter, never a lock */
  }
}

/**
 * Atomic create. True on win, false when someone already holds it.
 *
 * Write to a private temp, then publish with `link(2)`. Both halves matter.
 *
 * `link` is atomic and refuses to clobber: it either creates the lock path or
 * fails EEXIST, so it is as exclusive as `open(…, 'wx')`. What it adds is that
 * the file is COMPLETE before it is ever reachable under the lock's name.
 *
 * Writing in place cannot promise that, and the failure is not cosmetic. A
 * write or close that fails after the create leaves an empty file; an empty
 * body parses as nothing, `readLock` reports that as an unreadable holder, and
 * an unreadable holder is refused rather than reclaimed — deliberately, since
 * guessing about a lock you cannot read is how you get two writers. For a
 * caller with no staleness policy that is permanent, not transient.
 *
 * Nor can it be patched up by deleting the path on failure: between the failed
 * write and the delete, a forcing caller can replace the file, and the cleanup
 * would then remove THEIR lock. Publishing a finished file removes both
 * problems at once — nothing partial is ever visible, and the only thing this
 * function deletes is its own temp, which no other process can name.
 */
function createExclusive(file, body, mode) {
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  try {
    // The hard link shares this inode, so `mode` lands on the published lock.
    fs.writeFileSync(tmp, body, { mode });
  } catch (err) {
    discardTemp(tmp);
    throw err;
  }
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    // EEXIST covers a directory lock left by an older release too.
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    discardTemp(tmp);
  }
}

/**
 * Identity of whatever currently sits at `file` — its exact bytes, which carry
 * a per-acquire nonce and so differ between any two holders. Null when absent.
 * Directory locks from older releases have no bytes to read, so they fall back
 * to stat; they are always reclaimed wholesale anyway.
 */
function identityOf(raw, file) {
  if (raw !== null) return `raw:${raw}`;
  try {
    const st = fs.statSync(file);
    return `stat:${st.dev}:${st.ino}:${st.birthtimeMs}`;
  } catch {
    return null;
  }
}

function lockIdentity(file) {
  return identityOf(readRaw(file), file);
}

// `recursive` so a directory lock left by an older release is cleared too.
function removeLock(file) {
  try {
    fs.rmSync(file, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Remove the lock ONLY if it is still the one we judged reclaimable.
 *
 * Unconditional removal defeats the whole primitive: two processes that both
 * see the same stale lock would each delete and recreate, and the second
 * delete lands on the FIRST one's brand-new lock — leaving both believing they
 * hold it. Comparing content means we never delete a lock we did not evaluate;
 * if it changed under us we simply lose the race and re-evaluate against the
 * new holder.
 *
 * This narrows the window to the gap between the comparison and the unlink; it
 * does not abolish it. See KNOWN LIMIT at the top of this file for why, and
 * for why a second lock to serialize reclaims is not the answer.
 */
function removeIfUnchanged(file, identity) {
  if (identity === null || lockIdentity(file) !== identity) return false;
  removeLock(file);
  return true;
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
  // ONE read answers both questions. Reading the bytes for the identity and
  // then re-reading for the payload lets the lock change in between, so the
  // verdict could describe one holder while the identity names another — and
  // the reclaim would be authorised against a file nobody ever judged.
  const raw = readRaw(file);
  const identity = identityOf(raw, file);
  const held = parseLock(raw);
  const unreadable = held === null;
  const dead = !unreadable && spec.isHolderDead ? spec.isHolderDead(held) : false;
  const stale = agedOut(file, spec.staleAfterMs, now);

  if (dead || stale) return { takeover: true, forced: false, held, identity };
  if (force) return { takeover: true, forced: true, held, identity };
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
    // If this returns false the holder changed under us — fall through and
    // re-evaluate rather than deleting a lock we never judged.
    removeIfUnchanged(file, verdict.identity);
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
      body: JSON.stringify({ ...payload, [NONCE_KEY]: crypto.randomBytes(12).toString('hex') }),
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
    if (typeof opts.ownedBy !== 'function') {
      removeLock(file);
      return true;
    }
    // ONE read decides both questions: is this still ours, and are these still
    // the bytes we are about to delete. Checking ownership and then deleting
    // unconditionally lets a forced takeover slip in between, and the delete
    // would land on the new holder's lock — so a process that was forced out
    // would take the replacement down with it on its way out.
    const raw = readRaw(file);
    const held = parseLock(raw);
    if (!held || !opts.ownedBy(held)) return false;
    return removeIfUnchanged(file, identityOf(raw, file));
  }

  return Object.freeze({
    lockPathFor: spec.lockPathFor,
    read: (target) => readLock(spec.lockPathFor(target)),
    acquire,
    release,
  });
}

// `lockIdentity` / `removeIfUnchanged` are exported for direct testing: they
// are the compare-and-delete that keeps two reclaimers from both winning, and
// that guarantee is not reachable deterministically through `acquire` alone.
module.exports = { createFileLock, readLock, lockIdentity, removeIfUnchanged };
