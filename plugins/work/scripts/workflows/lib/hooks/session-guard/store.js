'use strict';

/**
 * session-guard/store.js — session file storage for the session guard.
 *
 * Owns the on-disk lifecycle of `claude-session-guard-<ticket>.json` files:
 * path sanitization, passphrase generation, ownership-checked reads, atomic
 * writes, and discovery of all active sessions in SESSION_DIR.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Session files live in /tmp by default. Files are created with mode 0o600 and
// ownership is verified before reading, but passphrases are stored in plaintext.
// This is acceptable for a single-user local CLI tool — not for shared CI hosts.
const SESSION_DIR = process.env.SESSION_GUARD_DIR || '/tmp';

// NATO phonetic alphabet words for passphrase generation
const NATO_WORDS = [
  'ALPHA',
  'BRAVO',
  'CHARLIE',
  'DELTA',
  'ECHO',
  'FOXTROT',
  'GOLF',
  'HOTEL',
  'INDIA',
  'JULIET',
  'KILO',
  'LIMA',
  'MIKE',
  'NOVEMBER',
  'OSCAR',
  'PAPA',
  'QUEBEC',
  'ROMEO',
  'SIERRA',
  'TANGO',
  'UNIFORM',
  'VICTOR',
  'WHISKEY',
  'XRAY',
  'YANKEE',
  'ZULU',
];

function sanitizeTicketId(ticketId) {
  // Strip path separators and null bytes to prevent path traversal
  const sanitized = String(ticketId).replace(/[/\\:\0]/g, '_');
  const baseDir = path.resolve(SESSION_DIR);
  const resolved = path.resolve(baseDir, `claude-session-guard-${sanitized}.json`);
  // Verify resolved path stays under SESSION_DIR (handle root "/" where baseDir + sep = "//")
  const prefix = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (!resolved.startsWith(prefix) && resolved !== baseDir) {
    throw new Error('Invalid ticketId: resolved path escapes SESSION_DIR');
  }
  return resolved; // validated: stays under SESSION_DIR
}

function sessionFilePath(ticketId) {
  return sanitizeTicketId(ticketId);
}

function generatePassphrase() {
  const w1 = NATO_WORDS[crypto.randomInt(NATO_WORDS.length)];
  const w2 = NATO_WORDS[crypto.randomInt(NATO_WORDS.length)];
  const num = String(crypto.randomInt(10000)).padStart(4, '0');
  return `${w1}-${w2}-${num}`;
}

/**
 * Check that a file belongs to the current user before trusting its content.
 * Platforms without getuid (Windows) fail open; an unreadable stat fails closed.
 */
function ownedByCurrentUser(filePath) {
  if (typeof process.getuid !== 'function') return true;
  try {
    return fs.statSync(filePath).uid === process.getuid();
  } catch {
    return false;
  }
}

function readSessionFile(ticketId) {
  try {
    const filePath = sessionFilePath(ticketId);
    // Verify ownership before reading (same check as findActiveSessions)
    if (!ownedByCurrentUser(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write session data atomically: write to tmp → unlink existing target → rename tmp → target.
 * Ensures SESSION_DIR exists, handles Windows (where rename fails if target exists),
 * and cleans up the tmp file on any error.
 */
function writeSessionAtomic(ticketId, data) {
  const target = sessionFilePath(ticketId);
  // Ensure the directory exists (SESSION_GUARD_DIR may point to a non-default/non-existent path)
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    // Unlink existing target before rename (required on Windows where rename fails if target exists)
    try {
      fs.unlinkSync(target);
    } catch {
      /* ENOENT — target doesn't exist yet */
    }
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
 * Read one candidate session file, checking ownership BEFORE parsing content
 * so untrusted files are skipped early. Returns null for corrupt, foreign, or
 * schema-invalid files (must have ticketId + workflow + passphrase).
 */
function readOwnedSession(fullPath) {
  if (!ownedByCurrentUser(fullPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    // Validate schema: must have ticketId + workflow + passphrase to be a real session
    return data?.ticketId && data?.workflow && data?.passphrase ? data : null;
  } catch {
    return null;
  }
}

/**
 * Find all active session guard files in SESSION_DIR.
 * Checks file ownership before reading content to avoid parsing untrusted files.
 * Filters by filename prefix rather than scanning all of SESSION_DIR.
 */
function findActiveSessions() {
  const sessions = [];
  const baseDir = path.resolve(SESSION_DIR);
  const dirPrefix = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  try {
    for (const f of fs.readdirSync(baseDir)) {
      if (!f.startsWith('claude-session-guard-') || !f.endsWith('.json')) continue;
      const fullPath = path.resolve(baseDir, f);
      if (!fullPath.startsWith(dirPrefix)) continue;
      const data = readOwnedSession(fullPath);
      if (data) sessions.push(data);
    }
  } catch {
    /* can't read SESSION_DIR — fail open */
  }
  return sessions;
}

module.exports = {
  findActiveSessions,
  generatePassphrase,
  readSessionFile,
  sessionFilePath,
  writeSessionAtomic,
};
