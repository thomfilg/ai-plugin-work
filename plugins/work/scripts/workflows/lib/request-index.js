/**
 * request-index.js — Atomic counter ledger for out-of-flow request allocation (GH-219 Task 10)
 *
 * Manages `.request-index.json` per ticket directory with collision-safe increments.
 * Format: `{ "userSeq": n, "aiSeq": m, "version": 1 }`
 *
 * Uses the vendored safeIO writeJsonAtomic (write temp → rename) for atomic writes.
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
const { writeJsonAtomic } = require('./safeIO');
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
    let fd = -1;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // Retry immediately after evicting a stale lock; otherwise yield first.
        if (!removeStaleLock(lockPath)) yieldOnLock(lockPath);
        continue;
      }
      throw err;
    }
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  }
  return false;
}

/**
 * Evict a lock file older than 30s.
 * @param {string} lockPath
 * @returns {boolean} true if a stale lock was removed
 */
function removeStaleLock(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > 30000) {
      fs.unlinkSync(lockPath);
      return true;
    }
  } catch {
    /* lock disappeared or eviction raced — fall through to yield */
  }
  return false;
}

/**
 * Yield briefly before retry — fs.accessSync is a no-op syscall
 * that yields to the event loop without busy-spinning or sleeping.
 * @param {string} lockPath
 */
function yieldOnLock(lockPath) {
  try {
    fs.accessSync(lockPath);
  } catch {
    /* lock may have been released */
  }
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
 * Allocate the next request folder for the given sequence field, incrementing
 * the counter atomically under the index lock.
 *
 * @param {string} ticketId
 * @param {'userSeq'|'aiSeq'} seqField
 * @param {string} prefix - Directory segment prefix (e.g. "user-request-")
 * @returns {AllocationResult}
 */
function allocateNext(ticketId, seqField, prefix) {
  validateTicketId(ticketId);
  const lockPath = indexPath(ticketId) + '.lock';
  if (!acquireLock(lockPath)) {
    throw new Error(`Failed to acquire index lock for ${ticketId} — concurrent contention`);
  }
  try {
    const current = readIndex(ticketId);
    const nextSeq = current[seqField] + 1;
    writeJsonAtomic(indexPath(ticketId), { ...current, [seqField]: nextSeq }, { mode: 0o644 });
    const segment = `${prefix}${nextSeq}`;
    const root = path.join(ticketDir(ticketId), segment);
    fs.mkdirSync(root, { recursive: true });
    return { seq: nextSeq, segment, root };
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Allocate the next user-request folder, incrementing the counter atomically.
 *
 * @param {string} ticketId
 * @returns {AllocationResult}
 */
function nextUserRequest(ticketId) {
  return allocateNext(ticketId, 'userSeq', USER_REQUEST_PREFIX);
}

/**
 * Allocate the next ai-request folder, incrementing the counter atomically.
 *
 * @param {string} ticketId
 * @returns {AllocationResult}
 */
function nextAiRequest(ticketId) {
  return allocateNext(ticketId, 'aiSeq', AI_REQUEST_PREFIX);
}

module.exports = {
  nextUserRequest,
  nextAiRequest,
  readIndex,
  INDEX_FILENAME,
  INDEX_VERSION,
};
