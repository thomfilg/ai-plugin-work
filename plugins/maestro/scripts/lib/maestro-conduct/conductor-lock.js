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
function acquire(file, { force = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = readLock(file);
  const liveOther =
    existing && existing.pid && existing.pid !== process.pid && pidAlive(existing.pid);
  if (liveOther && !force) return { ok: false, held: existing };

  const info = {
    pid: process.pid,
    startedAt: Math.floor(Date.now() / 1000),
    host: os.hostname(),
    ns: process.env.MAESTRO_NS || '',
  };
  // 0o600: the lock holds only pid/host/ns, and its parent dir is already
  // 0o700, but set the mode explicitly so it never depends on the umask.
  fs.writeFileSync(file, JSON.stringify(info), { mode: 0o600 });
  return { ok: true, info, forced: !!liveOther };
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
