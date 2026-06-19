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
    // Atomic create-exclusive (O_CREAT|O_EXCL via 'wx'): only ONE concurrent
    // caller can win, which closes the read-check-write TOCTOU window that
    // previously let two daemons both acquire the same namespace (GH-622).
    // 0o600: the lock holds only pid/host/ns; set the mode explicitly so it
    // never depends on the umask (parent dir is already 0o700).
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeSync(fd, payload);
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, info, forced };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }

    // A lock file already exists — decide whether we may take it over.
    const existing = readLock(file);
    if (existing === null) {
      // Present but unreadable — most likely a concurrent creator mid-write.
      // Never steal it unless forced; refusing preserves the singleton guarantee.
      if (!force) return { ok: false, held: { pid: null } };
    } else {
      const liveOther =
        existing.pid && existing.pid !== process.pid && pidAlive(existing.pid);
      if (liveOther && !force) return { ok: false, held: existing };
      if (liveOther) forced = true;
    }
    // Stale holder, our own pid, or a forced takeover: remove and retry create.
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
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
