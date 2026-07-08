'use strict';

/**
 * safeIO — canonical fail-open readers + Windows-aware atomic writers.
 *
 * Decision matrix, in prose:
 *
 * Readers fail OPEN. Any error — missing file, permission denied, path is a
 * directory, malformed JSON — returns the caller-supplied fallback. Readers
 * never throw and never write to stderr: "could not read" is reported as
 * "no data", and the caller decides what an absent value means.
 *
 * Writers fail CLOSED. A write that cannot complete throws, because a
 * silently dropped write corrupts downstream state. Atomicity is the
 * rename(2) kind: the payload lands in a pid-suffixed sibling tmp file,
 * which is renamed DIRECTLY over the target. POSIX rename(2) atomically
 * replaces an existing destination, so a concurrent reader observes either
 * the old complete content or the new complete content — never a missing
 * file, never a truncated intermediate. Only on win32, where rename can
 * refuse an existing destination (EPERM/EEXIST/EACCES), the target is
 * unlinked best-effort and the rename retried once — a brief missing-file
 * window exists there and nowhere else. If the tmp write or the (final)
 * rename fails, the tmp file is removed best-effort and the original error
 * is rethrown. The parent directory is created on demand. No fsync is
 * issued anywhere: durability across power loss is out of scope; only
 * reader-visible atomicity is guaranteed.
 *
 * JSON writes are pretty-printed (two-space indent) unless the caller passes
 * `compact: true`. File mode defaults to 0o600 (private state files); pass
 * `mode` for anything that must be group/world readable.
 */

const fs = require('fs');
const path = require('path');

function requireTargetPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('safeIO: missing "path"');
  }
}

/**
 * Read a file as utf8, returning `fallback` on ANY error. Never throws.
 * @param {string} filePath
 * @param {*} [fallback=null]
 * @returns {string|*}
 */
function readFileSafe(filePath, fallback = null) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

/**
 * Read + JSON.parse a file, returning `fallback` on ANY error (missing,
 * unreadable, malformed). Never throws.
 * @param {string} filePath
 * @param {*} [fallback={}]
 * @returns {*}
 */
function readJsonSafe(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Best-effort unlink: every failure (ENOENT included) is swallowed. */
function removeIfPresent(candidate) {
  try {
    fs.unlinkSync(candidate);
  } catch {
    /* best-effort — a missing candidate is the common, expected case */
  }
}

/**
 * Rename error codes that mean "the destination already exists" on Windows,
 * where rename refuses to overwrite. Everywhere else rename(2) replaces the
 * destination atomically in place.
 */
const WIN32_RENAME_RETRY_CODES = new Set(['EPERM', 'EEXIST', 'EACCES']);

/**
 * Promote the tmp file over the target with a DIRECT rename — an atomic
 * overwrite on POSIX, so there is no instant at which the target is
 * missing. Only on win32, when the rename is refused because the
 * destination exists (EPERM/EEXIST/EACCES), the target is unlinked
 * best-effort and the rename retried once. Any other rename failure — or a
 * failed retry — removes the tmp best-effort and rethrows.
 */
function promoteTmp(tmp, target) {
  try {
    fs.renameSync(tmp, target);
    return;
  } catch (renameErr) {
    if (process.platform !== 'win32' || !WIN32_RENAME_RETRY_CODES.has(renameErr.code)) {
      removeIfPresent(tmp);
      throw renameErr;
    }
  }
  removeIfPresent(target);
  try {
    fs.renameSync(tmp, target);
  } catch (retryErr) {
    removeIfPresent(tmp);
    throw retryErr;
  }
}

/** Shared atomic-replace core used by both public writers. */
function atomicReplace(target, payload, mode) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, payload, { mode });
  } catch (writeErr) {
    removeIfPresent(tmp); // drop any partial tmp (ENOSPC mid-write, …)
    throw writeErr;
  }
  promoteTmp(tmp, target);
}

/**
 * Atomically write `text` to `filePath` (tmp + rename, Windows-aware).
 * @param {string} filePath
 * @param {string} text
 * @param {{mode?: number}} [opts] — mode defaults to 0o600
 */
function writeFileAtomic(filePath, text, opts = {}) {
  requireTargetPath(filePath);
  atomicReplace(filePath, text, opts.mode === undefined ? 0o600 : opts.mode);
}

/**
 * Atomically write `data` as JSON. Pretty-printed (two-space indent) unless
 * `opts.compact === true`.
 * @param {string} filePath
 * @param {*} data
 * @param {{mode?: number, compact?: boolean}} [opts] — mode defaults to 0o600
 */
function writeJsonAtomic(filePath, data, opts = {}) {
  const payload = opts.compact === true ? JSON.stringify(data) : JSON.stringify(data, null, 2);
  writeFileAtomic(filePath, payload, opts);
}

module.exports = { readFileSafe, readJsonSafe, writeFileAtomic, writeJsonAtomic };
