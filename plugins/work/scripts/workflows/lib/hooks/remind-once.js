'use strict';

/**
 * remind-once — session-scoped reminder ledger primitive (GH-773).
 *
 * A generic helper any reminder-style UserPromptSubmit hook consults to decide
 * whether it has already injected a given reminder THIS session. Keyed by
 * session id (file) + reminder id (entry) — NEVER by cwd (the GH-583
 * anti-pattern: two sessions in the same folder must stay distinct, and the
 * same session across two prompts must dedupe).
 *
 * Session-id resolution (matches inject-ledger leg order without the cross-
 * plugin require): `normalizeHookPayload(payload).sessionId` (payload
 * `session_id` first, then CLAUDE_CODE_SESSION_ID env) → else a documented
 * `sha256(cwd + processStart)` degradation. The env leg (CLAUDE_CODE_SESSION_ID)
 * rotates on `/clear` and per new conversation — exactly the re-arm semantics
 * a once-per-session reminder needs. The resolved id is sanitized through
 * SAFE_ID_RE (unsafe → sha256-hashed) before use as a filename (path-traversal
 * guard).
 *
 * Storage: `~/.claude/work-workflow/.reminders/<sessionId>.json`, overridable
 * via `REMIND_ONCE_SESSION_DIR` for tests. Shape:
 *   `{ createdAt, sessionId, reminders: { <reminderId>: { firedAt, count } } }`.
 * Stores reminder ids + counters + timestamps ONLY — no prompt text, no bodies.
 *
 * Fail-open discipline: every function returns a safe default on IO error and
 * never throws. `shouldRemind` on a ledger READ error fails toward `true` so a
 * transient IO error never silently suppresses a genuine first injection.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { normalizeHookPayload } = require('../runtime/payload');
const { writeJsonAtomic } = require('../safeIO');
const { logHookError } = require('../hook-error-log');

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PROCESS_START_TIME = Date.now();

function log(err) {
  try {
    logHookError('remind-once', err);
  } catch {
    /* fail-open */
  }
}

function hashId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

/** Safe passthrough or sha256-hashed; falls back to the cwd+start hash. */
function sanitizeSessionId(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return hashId(`${process.cwd()}|${PROCESS_START_TIME}`);
  }
  return SAFE_ID_RE.test(raw) ? raw : hashId(raw);
}

function sessionDir() {
  if (process.env.REMIND_ONCE_SESSION_DIR) return process.env.REMIND_ONCE_SESSION_DIR;
  return path.join(os.homedir(), '.claude', 'work-workflow', '.reminders');
}

function ledgerPath(sessionId) {
  return path.join(sessionDir(), `${sessionId}.json`);
}

function ensureDir() {
  try {
    fs.mkdirSync(sessionDir(), { recursive: true });
  } catch (err) {
    log(err);
  }
}

function emptyLedger(sessionId) {
  return { createdAt: new Date().toISOString(), sessionId: sessionId || '', reminders: {} };
}

/**
 * Resolve a session id from the hook payload; degrade to sha256(cwd+start) when
 * none is resolvable. Always sanitized for safe filename use.
 */
function resolveSessionId(payload) {
  try {
    const resolved = normalizeHookPayload(payload).sessionId;
    return sanitizeSessionId(resolved);
  } catch (err) {
    log(err);
    return sanitizeSessionId(null);
  }
}

/**
 * Read + parse a ledger. Returns { ledger } on success/empty, or { error:true }
 * on a read/parse failure (oversized, unreadable, malformed JSON) so callers
 * can fail toward emitting.
 */
function loadLedger(sessionId) {
  const file = ledgerPath(sessionId);
  let raw;
  try {
    // Read directly (no existsSync/stat-then-read TOCTOU): a missing ledger is
    // the common first-prompt case, handled as ENOENT below.
    raw = fs.readFileSync(file, 'utf8');
    if (raw.length <= 0 || Buffer.byteLength(raw) > MAX_FILE_BYTES) {
      return { error: true };
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ledger: emptyLedger(sessionId) };
    log(err);
    return { error: true };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.reminders !== 'object') {
      return { error: true };
    }
    return { ledger: parsed };
  } catch (err) {
    log(err);
    return { error: true };
  }
}

/**
 * Whether a reminder should fire this prompt. `every-prompt` → always true;
 * `once-per-session` → true iff no ledger entry exists for the pair. A ledger
 * READ error fails toward true (never suppresses a genuine first injection).
 */
function shouldRemind(sessionId, reminderId, cadence) {
  if (cadence === 'every-prompt') return true;
  const result = loadLedger(sessionId);
  if (result.error) return true;
  return !result.ledger.reminders[reminderId];
}

/** Record a fired reminder: write/increment { firedAt, count } atomically. */
function recordReminder(sessionId, reminderId) {
  try {
    ensureDir();
    const result = loadLedger(sessionId);
    const ledger = result.error ? emptyLedger(sessionId) : result.ledger;
    const prev = ledger.reminders[reminderId];
    ledger.reminders[reminderId] = {
      firedAt: new Date().toISOString(),
      count: (prev && Number(prev.count) ? Number(prev.count) : 0) + 1,
    };
    writeJsonAtomic(ledgerPath(sessionId), ledger, { compact: true });
  } catch (err) {
    log(err);
  }
}

/** Re-arm all once-per-session reminders for a session (removes its ledger). */
function resetForSession(sessionId) {
  try {
    fs.rmSync(ledgerPath(sessionId), { force: true });
  } catch (err) {
    log(err);
  }
}

/** Whether the ledger file at `p` is older than `cutoff` (fail-open: false). */
function isStaleLedger(p, cutoff) {
  try {
    return fs.statSync(p).mtimeMs < cutoff;
  } catch {
    return false;
  }
}

/** Delete ledger files older than maxAgeMs (7-day default). Fail-open per-file. */
function gcStaleLedgers(opts) {
  try {
    const maxAgeMs = (opts && Number(opts.maxAgeMs)) || DEFAULT_MAX_AGE_MS;
    const cutoff = Date.now() - maxAgeMs;
    const dir = sessionDir();
    const stale = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(dir, name))
      .filter((p) => isStaleLedger(p, cutoff));
    for (const p of stale) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* fail-open per-file */
      }
    }
  } catch (err) {
    log(err);
  }
}

module.exports = {
  SAFE_ID_RE,
  resolveSessionId,
  shouldRemind,
  recordReminder,
  resetForSession,
  gcStaleLedgers,
};
