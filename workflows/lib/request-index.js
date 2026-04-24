/**
 * request-index.js — Atomic counter ledger for out-of-flow request allocation (GH-219 Task 10)
 *
 * Manages `.request-index.json` per ticket directory with collision-safe increments.
 * Format: `{ "userSeq": n, "aiSeq": m, "version": 1 }`
 *
 * Uses the atomic rename pattern (write temp → rename) from session-guard.js.
 *
 * Requirements:
 *   R9:  Out-of-flow user routing — `user-request-${n}`
 *   R10: Out-of-flow AI routing — `ai-request-${n}`
 *   R11: Persistent `.request-index.json` with collision-safe increments
 *   R7:  Allocator completion — wires the stubs from Task 9
 *
 * @module request-index
 */

const fs = require('fs');
const path = require('path');

const { USER_REQUEST_PREFIX, AI_REQUEST_PREFIX } = require('./allocate-output-folder');
const {
  validateTicketId,
  sanitizeTicketId,
  resolveTasksBase,
  assertPathContainment,
} = require('./ticket-validation');

// ─── Constants ───────────────────────────────────────────────────────────────

const INDEX_FILENAME = '.request-index.json';
const INDEX_VERSION = 1;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve the ticket directory path.
 * @param {string} ticketId
 * @returns {string}
 */
function ticketDir(ticketId) {
  const base = resolveTasksBase();
  const dir = path.resolve(base, sanitizeTicketId(ticketId));
  assertPathContainment(dir, base, 'ticketDir');
  return dir;
}

/**
 * Resolve the `.request-index.json` path for a ticket.
 * @param {string} ticketId
 * @returns {string}
 */
function indexPath(ticketId) {
  return path.join(ticketDir(ticketId), INDEX_FILENAME);
}

/**
 * @typedef {Object} RequestIndex
 * @property {number} userSeq - Current user request sequence number
 * @property {number} aiSeq - Current AI request sequence number
 * @property {number} version - Schema version
 */

/**
 * Read the current index from disk. Returns zeroed defaults if the file does not exist.
 * @param {string} ticketId
 * @returns {RequestIndex}
 */
function readIndex(ticketId) {
  validateTicketId(ticketId);
  const filePath = indexPath(ticketId);
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return {
      userSeq: typeof raw.userSeq === 'number' ? raw.userSeq : 0,
      aiSeq: typeof raw.aiSeq === 'number' ? raw.aiSeq : 0,
      version: INDEX_VERSION,
    };
  } catch (err) {
    // Only default to zeros on missing file; fail closed on other errors
    if (err && err.code === 'ENOENT') {
      return { userSeq: 0, aiSeq: 0, version: INDEX_VERSION };
    }
    throw err;
  }
}

/**
 * Write index atomically: write to temp file, then rename.
 * Pattern borrowed from session-guard.js writeSessionAtomic.
 * @param {string} ticketId
 * @param {RequestIndex} data
 */
function writeIndexAtomic(ticketId, data) {
  const target = indexPath(ticketId);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o644 });
  try {
    // rename(2) is atomic on POSIX — overwrites target atomically.
    fs.renameSync(tmp, target);
  } catch (renameErr) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* cleanup best-effort */
    }
    throw renameErr;
  }
}

/**
 * Acquire a simple lock file for the read-modify-write cycle.
 * Uses O_EXCL (wx) for atomic create — fails if lock already exists.
 * Retries a few times with brief delay to handle contention.
 * @param {string} lockPath
 * @returns {boolean} true if lock acquired
 */
function acquireLock(lockPath) {
  const MAX_RETRIES = 5;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // Check if lock is stale (older than 30s)
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 30000) {
            fs.unlinkSync(lockPath);
            continue; // retry after removing stale lock
          }
        } catch {
          /* lock disappeared — retry */
        }
        // Yield briefly before retry — fs.accessSync is a no-op syscall
        // that yields to the event loop without busy-spinning or sleeping.
        try {
          fs.accessSync(lockPath);
        } catch {
          /* lock may have been released */
        }
        continue; // retry after brief yield
      }
      throw err;
    }
  }
  return false;
}

/**
 * Release the lock file.
 * @param {string} lockPath
 */
function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* best-effort */
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AllocationResult
 * @property {number} seq - The allocated sequence number
 * @property {string} segment - Directory segment name (e.g. "user-request-1")
 * @property {string} root - Absolute path to the allocated directory
 */

/**
 * Allocate the next user-request folder, incrementing the counter atomically.
 *
 * @param {string} ticketId
 * @returns {AllocationResult}
 */
function nextUserRequest(ticketId) {
  validateTicketId(ticketId);
  const lockPath = indexPath(ticketId) + '.lock';
  if (!acquireLock(lockPath)) {
    throw new Error(`Failed to acquire index lock for ${ticketId} — concurrent contention`);
  }
  try {
    const current = readIndex(ticketId);
    const nextSeq = current.userSeq + 1;
    const updated = { ...current, userSeq: nextSeq };
    writeIndexAtomic(ticketId, updated);
    const segment = `${USER_REQUEST_PREFIX}${nextSeq}`;
    const root = path.join(ticketDir(ticketId), segment);
    fs.mkdirSync(root, { recursive: true });
    return { seq: nextSeq, segment, root };
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Allocate the next ai-request folder, incrementing the counter atomically.
 *
 * @param {string} ticketId
 * @returns {AllocationResult}
 */
function nextAiRequest(ticketId) {
  validateTicketId(ticketId);
  const lockPath = indexPath(ticketId) + '.lock';
  if (!acquireLock(lockPath)) {
    throw new Error(`Failed to acquire index lock for ${ticketId} — concurrent contention`);
  }
  try {
    const current = readIndex(ticketId);
    const nextSeq = current.aiSeq + 1;
    const updated = { ...current, aiSeq: nextSeq };
    writeIndexAtomic(ticketId, updated);

    const segment = `${AI_REQUEST_PREFIX}${nextSeq}`;
    const root = path.join(ticketDir(ticketId), segment);
    fs.mkdirSync(root, { recursive: true });

    return { seq: nextSeq, segment, root };
  } finally {
    releaseLock(lockPath);
  }
}

module.exports = {
  nextUserRequest,
  nextAiRequest,
  readIndex,
  INDEX_FILENAME,
  INDEX_VERSION,
};
