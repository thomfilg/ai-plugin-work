'use strict';

/**
 * inject-ledger — per-session injection ledger for synapsys fire_mode.
 *
 * Session-id resolution chain (spec §3.2):
 *   1. `payload.session_id` when it matches /^[A-Za-z0-9_-]{1,128}$/.
 *   2. Unsafe `payload.session_id` is sha1-hashed (path-traversal guard, spec §4.1)
 *      — never used raw on the filesystem.
 *   3. Otherwise read `~/.claude/synapsys/.session/.current` if present.
 *   4. Otherwise compute `sha1(cwd + processStartTime)`, write it to `.current`,
 *      and return it.
 *
 * Storage (spec §3.3): `~/.claude/synapsys/.session/<session_id>.json` with shape
 *   `{ createdAt, sessionId, memories: { <name>: { injectedCount, lastFullInjectAt } } }`.
 *
 * Invariants:
 *   - Fail-open (R1): every IO call returns the empty-ledger value on error.
 *   - 64 KB cap (spec §4.2): oversized files are treated as missing.
 *   - 7-day GC (spec §4.2): `gcStaleLedgers` removes `.session/*.json` past cutoff.
 *   - Persists memory names + integer counters only (spec §4.3) — no bodies, no prompts.
 *   - `processStartTime` is captured once at module load (sub-millisecond hot path, R2).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const MAX_FILE_BYTES = 64 * 1024;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PROCESS_START_TIME = Date.now();

function sessionDir() {
  // SYNAPSYS_SESSION_DIR lets tests isolate ledger state into a per-test
  // tmpdir; absent → the real per-user location.
  if (process.env.SYNAPSYS_SESSION_DIR) return process.env.SYNAPSYS_SESSION_DIR;
  return path.join(os.homedir(), '.claude', 'synapsys', '.session');
}

function ledgerPath(sessionId) {
  return path.join(sessionDir(), `${sessionId}.json`);
}

function emptyLedger(sessionId) {
  return {
    createdAt: new Date().toISOString(),
    sessionId: sessionId || '',
    memories: {},
  };
}

function ensureDir() {
  try {
    fs.mkdirSync(sessionDir(), { recursive: true });
  } catch {
    /* fail-open */
  }
}

function hashId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function resolveFromPayload(payload) {
  const raw = payload && payload.session_id;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return SAFE_ID_RE.test(raw) ? raw : hashId(raw);
}

function readBoundedFile(p, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const st = fs.fstatSync(fd);
    if (!st || !st.isFile()) return null;
    if (st.size <= 0 || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.slice(0, off).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* fail-open */
      }
    }
  }
}

function readCurrentSessionFile(currentPath) {
  const raw = readBoundedFile(currentPath, 255);
  if (raw === null) return null;
  const v = raw.trim();
  return v && SAFE_ID_RE.test(v) ? v : null;
}

function writeCurrentSessionFile(currentPath, value) {
  try {
    fs.writeFileSync(currentPath, value);
  } catch {
    /* fail-open */
  }
}

function computeFallbackId() {
  return hashId(`${process.cwd()}|${PROCESS_START_TIME}`);
}

function resolveSessionId(payload) {
  try {
    const fromPayload = resolveFromPayload(payload);
    if (fromPayload) return fromPayload;
    ensureDir();
    const currentPath = path.join(sessionDir(), '.current');
    const existing = readCurrentSessionFile(currentPath);
    if (existing) return existing;
    const computed = computeFallbackId();
    writeCurrentSessionFile(currentPath, computed);
    return computed;
  } catch {
    return computeFallbackId();
  }
}

function readLedgerFile(sessionId) {
  return readBoundedFile(ledgerPath(sessionId), MAX_FILE_BYTES);
}

function normalizeLedger(parsed, sessionId, empty) {
  if (!parsed || typeof parsed !== 'object') return empty;
  if (!parsed.memories || typeof parsed.memories !== 'object') {
    parsed.memories = {};
  }
  if (typeof parsed.createdAt !== 'string') {
    parsed.createdAt = empty.createdAt;
  }
  if (typeof parsed.sessionId !== 'string') {
    parsed.sessionId = sessionId || '';
  }
  return parsed;
}

function loadLedger(sessionId) {
  const empty = emptyLedger(sessionId);
  try {
    const raw = readLedgerFile(sessionId);
    if (raw === null) return empty;
    return normalizeLedger(JSON.parse(raw), sessionId, empty);
  } catch {
    return empty;
  }
}

function saveLedger(sessionId, ledger) {
  try {
    ensureDir();
    const data = ledger && typeof ledger === 'object' ? ledger : emptyLedger(sessionId);
    fs.writeFileSync(ledgerPath(sessionId), JSON.stringify(data));
  } catch {
    /* fail-open */
  }
}

function recordInjection(sessionId, memoryName, opts) {
  try {
    const full = !!(opts && opts.full);
    const ledger = loadLedger(sessionId);
    const entry = ledger.memories[memoryName] || {
      injectedCount: 0,
      lastFullInjectAt: 0,
    };
    entry.injectedCount = (Number(entry.injectedCount) || 0) + 1;
    if (full) {
      entry.lastFullInjectAt = entry.injectedCount;
    }
    ledger.memories[memoryName] = entry;
    saveLedger(sessionId, ledger);
  } catch {
    /* fail-open */
  }
}

function resetLedgerForSession(sessionId) {
  try {
    saveLedger(sessionId, emptyLedger(sessionId));
  } catch {
    /* fail-open */
  }
}

function gcStaleLedgers(opts) {
  try {
    const maxAgeMs = (opts && Number(opts.maxAgeMs)) || 0;
    if (!maxAgeMs) return;
    const dir = sessionDir();
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - maxAgeMs;
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs < cutoff) {
          fs.rmSync(p, { force: true });
        }
      } catch {
        /* fail-open per-file */
      }
    }
  } catch {
    /* never throws */
  }
}

function publishCurrentSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SAFE_ID_RE.test(sessionId)) return;
  try {
    ensureDir();
    writeCurrentSessionFile(path.join(sessionDir(), '.current'), sessionId);
  } catch {
    /* fail-open */
  }
}

module.exports = {
  resolveSessionId,
  loadLedger,
  saveLedger,
  recordInjection,
  resetLedgerForSession,
  gcStaleLedgers,
  publishCurrentSessionId,
};
