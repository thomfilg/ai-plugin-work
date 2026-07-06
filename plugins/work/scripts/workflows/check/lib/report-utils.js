/**
 * report-utils.js — shared helpers for /check report artifacts and
 * orchestrator serialization (GH-611, GH-343).
 *
 * - reportPresent():   a *.check.md report only counts when it exists AND is
 *                      non-empty. The observed clobber race truncates sibling
 *                      reports to 0 bytes, and a 0-byte report must be treated
 *                      as MISSING, never as done.
 * - writeReportAtomic: tmp + rename(2) so a reader/purger never observes a
 *                      half-written or truncated report.
 * - acquireLock/releaseLock: O_EXCL (wx) pid lockfile with staleness
 *                      detection, so the PostToolUse auto-advance hook and a
 *                      manual check-next.js invocation can't interleave step
 *                      execution against the same ticket state.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Locks older than this are reclaimed even if we can't prove the owner died
// (e.g. pid recycled). Steps like 4_run_tests can legitimately hold the lock
// for minutes, so keep this generous.
const DEFAULT_STALE_MS = 15 * 60 * 1000;

/**
 * True when the report file exists AND has content.
 * A 0-byte file (clobber-race victim) counts as missing.
 * @param {string} p
 * @returns {boolean}
 */
function reportPresent(p) {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

/**
 * Classify a report path: 'present' | 'empty' | 'absent'.
 * 'empty' (exists but 0 bytes) is surfaced distinctly so the orchestrator can
 * say "agent reported success but the report was truncated" instead of
 * silently re-dispatching.
 * @param {string} p
 * @returns {'present'|'empty'|'absent'}
 */
function reportStatus(p) {
  try {
    return fs.statSync(p).size > 0 ? 'present' : 'empty';
  } catch {
    return 'absent';
  }
}

/**
 * Atomically write a report: write to a tmp file in the same directory, then
 * rename(2) over the target. Readers never see a partial/empty file.
 * @param {string} target
 * @param {string} content
 */
function writeReportAtomic(target, content) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

// True when the pid recorded in the lockfile is verifiably dead.
function lockOwnerDead(lockPath) {
  try {
    const pid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0); // throws ESRCH when the process no longer exists
    return false;
  } catch (err) {
    return Boolean(err && err.code === 'ESRCH');
  }
}

/**
 * Acquire a pid lockfile with O_EXCL. Non-blocking: a single attempt (plus
 * stale reclamation) — callers that lose the race should back off and let the
 * lock holder finish, NOT wait.
 *
 * Stale locks are reclaimed when the owning pid is dead, or when the lockfile
 * is older than `staleMs` (owner unkillable-but-gone, pid recycled, etc).
 *
 * @param {string} lockPath
 * @param {{staleMs?: number}} [opts]
 * @returns {boolean} true when the lock was acquired
 */
// Single O_EXCL create attempt. True on success, false when already held.
function tryCreateLock(lockPath) {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;
    return false;
  }
}

// A held lock is stale when the owner pid is dead or the file exceeds staleMs.
function lockIsStale(lockPath, staleMs) {
  if (lockOwnerDead(lockPath)) return true;
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return true; // lock vanished between open and stat — retry
  }
}

function acquireLock(lockPath, opts = {}) {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreateLock(lockPath)) return true;
    // Held — reclaim only if provably stale, then retry the wx-create once.
    if (!lockIsStale(lockPath, staleMs)) return false;
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* someone else reclaimed it — retry wx anyway */
    }
  }
  return false;
}

/**
 * Release a lockfile (best-effort).
 * @param {string} lockPath
 */
function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* best-effort */
  }
}

module.exports = {
  reportPresent,
  reportStatus,
  writeReportAtomic,
  acquireLock,
  releaseLock,
  DEFAULT_STALE_MS,
};
