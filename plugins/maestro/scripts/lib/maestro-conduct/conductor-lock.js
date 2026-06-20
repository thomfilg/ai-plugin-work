'use strict';
/**
 * conductor-lock.js — per-namespace singleton guard for the maestro daemon.
 *
 * Two conductors on one machine in the same namespace both discover and drive
 * the same agents, racing on the shared `~/.cache/maestro-conduct/*.json`
 * markers (GH-622). This lock makes a second daemon detect the first:
 *   - acquire() returns { ok:false, held } when a LIVE conductor already holds
 *     the namespace lock — the caller refuses to start.
 *   - MAESTRO_FORCE=1 (passed as { force:true }) takes over the lock anyway.
 *   - A stale lock (holder pid dead) is reclaimed silently.
 *
 * The lock is co-located with the namespace's state dir (namespace.lockFile())
 * so it is naturally isolated per namespace — a second conductor in a DIFFERENT
 * namespace writes a different file and never conflicts.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** True when `pid` is a live process (EPERM ⇒ exists but not ours). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Try to claim `file`. Returns:
 *   { ok:true, info, forced }   — acquired (forced=true ⇒ took over a live lock)
 *   { ok:false, held }          — a live conductor holds it and force was false
 */
// True when `existing` names a live process other than us.
function isLiveOther(existing) {
  return !!(existing && existing.pid && existing.pid !== process.pid && pidAlive(existing.pid));
}

/**
 * Atomic create-exclusive (O_CREAT|O_EXCL via 'wx'): only ONE concurrent caller
 * can win, which closes the read-check-write TOCTOU window that previously let
 * two daemons both acquire the same namespace (GH-622). 0o600: the lock holds
 * only pid/host/ns; mode is explicit so it never depends on the umask (parent
 * dir is already 0o700). Returns true on create, false if the file exists.
 */
function createExclusive(file, payload) {
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  try {
    fs.writeSync(fd, payload);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function unlinkIfPresent(file) {
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

/**
 * Decide what to do when a lock file already exists this iteration:
 *   { refuse:true, held }  — bail out (a live other holds it, or it's
 *                            present-but-unreadable and we aren't forcing)
 *   { takeover:true, forced } — unlink + retry (stale / our own / forced)
 */
function evaluateHolder(file, force) {
  const existing = readLock(file);
  const liveOther = isLiveOther(existing);
  if (liveOther && !force) return { refuse: true, held: existing };
  if (existing === null && !force) return { refuse: true, held: { pid: null } };
  return { takeover: true, forced: liveOther };
}

function acquire(file, { force = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const info = {
    pid: process.pid,
    startedAt: Math.floor(Date.now() / 1000),
    host: os.hostname(),
    ns: process.env.MAESTRO_NS || '',
  };
  const payload = JSON.stringify(info);
  let forced = false;

  // Bounded retry: a stale/forced takeover unlinks then re-creates, and may
  // lose that re-create to a concurrent starter — re-evaluate instead of
  // looping forever.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (createExclusive(file, payload)) return { ok: true, info, forced };
    const verdict = evaluateHolder(file, force);
    if (verdict.refuse) return { ok: false, held: verdict.held };
    if (verdict.forced) forced = true;
    unlinkIfPresent(file);
  }
  // Lost the create race repeatedly — fail closed rather than risk two holders.
  return { ok: false, held: readLock(file) || { pid: null } };
}

/** Release `file` only if we still own it (best-effort). */
function release(file) {
  const cur = readLock(file);
  if (cur && cur.pid === process.pid) {
    try {
      fs.unlinkSync(file);
    } catch {}
  }
}

module.exports = { acquire, release, pidAlive, readLock };
