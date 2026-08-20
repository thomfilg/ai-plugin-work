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
 *
 * The atomic create / evaluate-holder / bounded-retry / ownership-checked
 * release machinery is shared with the migration runner and work-workflow's
 * task claims — see `lib/storeMigration/lock.js`, vendored into this plugin.
 * Only the liveness rule is maestro's: a holder counts while its pid is a live
 * process other than ours. This module keeps the daemon-facing result shape.
 */
const path = require('node:path');
const os = require('node:os');
const { createFileLock, readLock } = require(
  path.join(__dirname, '..', '..', '..', 'lib', 'storeMigration', 'lock')
);

/** True when `pid` is a live process (EPERM ⇒ exists but not ours). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// True when `existing` names a live process other than us. Anything else —
// our own stale entry, a dead pid — is ours to reclaim.
function isLiveOther(existing) {
  return !!(existing && existing.pid && existing.pid !== process.pid && pidAlive(existing.pid));
}

const locker = createFileLock({
  // Callers pass the lock file path itself, not a target to derive one from.
  lockPathFor: (file) => file,
  isHolderDead: (held) => !isLiveOther(held),
  retries: 5,
  mode: 0o600,
  dirMode: 0o700,
});

/**
 * Try to claim `file`. Returns:
 *   { ok:true, info, forced }   — acquired (forced=true ⇒ took over a live lock)
 *   { ok:false, held }          — a live conductor holds it and force was false
 */
function acquire(file, { force = false } = {}) {
  const info = {
    pid: process.pid,
    startedAt: Math.floor(Date.now() / 1000),
    host: os.hostname(),
    ns: process.env.MAESTRO_NS || '',
  };
  const res = locker.acquire(file, { payload: info, force });
  if (res.ok) return { ok: true, info: res.payload, forced: res.forced };
  return { ok: false, held: res.held && res.held.unreadable ? { pid: null } : res.held };
}

/** Release `file` only if we still own it (best-effort). */
function release(file) {
  locker.release(file, { ownedBy: (held) => held.pid === process.pid });
}

module.exports = { acquire, release, pidAlive, readLock };
