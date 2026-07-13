'use strict';

/**
 * session-id — shared session-id primitives for synapsys.
 *
 * Both `inject-ledger.js` (per-session injection ledger) and `telemetry.js`
 * (per-session JSONL writer) need to resolve a session id from the same
 * sources in the same way, or they end up keying their state files on
 * different ids — a memory could fire (ledger entry created) but the
 * matching telemetry event would land in a different session bucket.
 *
 * GH-583 added the `CLAUDE_CODE_SESSION_ID` env-var leg to inject-ledger
 * but left telemetry on its old payload-only path. This module is the
 * single source of truth so both consumers stay aligned.
 *
 * Public API:
 *   - SAFE_ID_RE                     — `/^[A-Za-z0-9_-]{1,128}$/`
 *   - hashId(value)                  — sha256 → hex(32) for unsafe values
 *   - sanitizeSessionId(raw)         — safe-passthrough or hashed; null on empty
 *   - resolveFromEnv()               — reads `process.env.CLAUDE_CODE_SESSION_ID`
 *   - resolveFromPayload(payload)    — reads `payload.session_id`
 *
 * All exports are pure and synchronous to preserve the sub-millisecond
 * hot-path invariant inherited from inject-ledger. Env-var reads are
 * wrapped in `try/catch` for fail-open behavior on hardened sandboxes
 * that throw on `process.env` access.
 */

const crypto = require('node:crypto');

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function hashId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function sanitizeSessionId(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return SAFE_ID_RE.test(raw) ? raw : hashId(raw);
}

function resolveFromEnv() {
  try {
    return sanitizeSessionId(process.env.CLAUDE_CODE_SESSION_ID);
  } catch {
    return null;
  }
}

function resolveFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return sanitizeSessionId(payload.session_id);
}

module.exports = {
  SAFE_ID_RE,
  hashId,
  sanitizeSessionId,
  resolveFromEnv,
  resolveFromPayload,
};
