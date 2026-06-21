'use strict';

/**
 * inject-ledger — per-session injection ledger for synapsys fire_mode.
 *
 * Session-id resolution chain (spec §3.2, GH-583):
 *   1. `process.env.CLAUDE_CODE_SESSION_ID` — authoritative. Validated by
 *      /^[A-Za-z0-9_-]{1,128}$/; unsafe values are sha256-hashed (path-traversal
 *      guard, spec §4.1). Empty/unset falls through to leg 2. Claude Code rotates
 *      this on `/clear` and per new conversation, which is exactly the semantics
 *      the ledger needs to model (GH-583). If a future Claude Code release renames
 *      or removes this var, legs 2–4 keep producing a working — but `/clear`-blind —
 *      id, so behavior degrades to the pre-GH-583 state rather than crashing.
 *   2. `payload.session_id` when safe; unsafe values are sha256-hashed.
 *   3. Otherwise read `~/.claude/synapsys/.session/.current` if present (advisory
 *      since GH-583 — still written by `publishCurrentSessionId` so out-of-process
 *      callers like `synapsys-list` can locate the active ledger).
 *   4. Otherwise compute `sha256(cwd + processStartTime)`, write it to `.current`,
 *      and return it.
 *
 * Additive export: `resolveSessionIdWithSource(payload) -> { sessionId, source }`
 * tags which leg of the chain produced the id (`'env' | 'payload' | 'current' |
 * 'fallback'`) for telemetry. The primary `resolveSessionId(payload) -> string`
 * contract is unchanged.
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
const sharedSessionId = require('./session-id');
const sessionIdRotation = require('./session-id-rotation');

const MAX_FILE_BYTES = 64 * 1024;
const SAFE_ID_RE = sharedSessionId.SAFE_ID_RE;
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

const hashId = sharedSessionId.hashId;
const resolveFromPayload = sharedSessionId.resolveFromPayload;
const resolveFromEnv = sharedSessionId.resolveFromEnv;

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

function resolveChain(payload) {
  try {
    const fromEnv = resolveFromEnv();
    if (fromEnv) {
      // Instrumentation pin (GH-583 follow-up): record env-var rotations to a
      // JSONL audit file so we can verify the once-per-conversation contract
      // post-hoc and warn if rotations come faster than a human `/clear`.
      sessionIdRotation.observeRotation(fromEnv);
      return { sessionId: fromEnv, source: 'env' };
    }
    const fromPayload = resolveFromPayload(payload);
    if (fromPayload) return { sessionId: fromPayload, source: 'payload' };
    ensureDir();
    const currentPath = path.join(sessionDir(), '.current');
    const existing = readCurrentSessionFile(currentPath);
    if (existing) return { sessionId: existing, source: 'current' };
    const computed = computeFallbackId();
    writeCurrentSessionFile(currentPath, computed);
    return { sessionId: computed, source: 'fallback' };
  } catch {
    return { sessionId: computeFallbackId(), source: 'fallback' };
  }
}

function resolveSessionId(payload) {
  return resolveChain(payload).sessionId;
}

function resolveSessionIdWithSource(payload) {
  return resolveChain(payload);
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
  resolveSessionIdWithSource,
  loadLedger,
  saveLedger,
  recordInjection,
  resetLedgerForSession,
  gcStaleLedgers,
  publishCurrentSessionId,
};
