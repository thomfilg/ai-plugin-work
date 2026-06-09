'use strict';

/**
 * session-id-rotation — instrumentation pin for CLAUDE_CODE_SESSION_ID rotation cadence.
 *
 * Why this exists
 * ---------------
 * GH-583's fix assumes Claude Code rotates `CLAUDE_CODE_SESSION_ID` exactly
 * once per conversation (on `/clear` and on opening a new session) — and never
 * per prompt within the same conversation. If that contract ever changes (an
 * Anthropic refactor, an opt-in beta, a regression), the symptom is silent
 * over-injection: every prompt sees a fresh ledger because the id rotated,
 * so `fire_mode: once` becomes `fire_mode: always` and no test catches it.
 *
 * This module persists each rotation it observes to a JSONL file so the
 * cadence is auditable after the fact. The JSONL audit (with
 * `fastRotation: true` on sub-threshold rows) is the durable signal and
 * is always written. A complementary one-shot stderr warning fires only
 * when `SYNAPSYS_DEBUG=1` is set — Claude Code surfaces hook stderr to
 * operators in some UI configurations, so we keep it opt-in to avoid
 * default-on noise the day Anthropic changes rotation cadence.
 *
 * Everything is fail-open and synchronous to preserve the sub-millisecond
 * hot-path invariant.
 *
 * Public API:
 *   - observeRotation(currentId) — call once per resolveSessionId; idempotent
 *   - rotationsFile()            — path to the JSONL audit file
 *   - lastObservedFile()         — path to the single-id pointer file
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Fast-rotation threshold: anything below this between two consecutive
// rotations triggers the stderr warning. 5 s is well below a human reaction
// time for `/clear` + first prompt, so the false-positive rate is low.
const FAST_ROTATION_THRESHOLD_MS = 5_000;

function telemetryDir() {
  return path.join(os.homedir(), '.claude', 'synapsys', '.telemetry');
}

function sessionDir() {
  if (process.env.SYNAPSYS_SESSION_DIR) return process.env.SYNAPSYS_SESSION_DIR;
  return path.join(os.homedir(), '.claude', 'synapsys', '.session');
}

function lastObservedFile() {
  return path.join(sessionDir(), '.last-observed-id');
}

/**
 * Path to the rotation audit JSONL. The leading DOUBLE underscore is
 * intentional and load-bearing: every reader that iterates the telemetry
 * directory MUST skip files starting with `__` so these sidecar rows
 * don't get mis-parsed as per-session memory events. Single-underscore
 * names (e.g. `_unknown-session.jsonl`, or any session id starting with
 * `_` per SAFE_ID_RE) are legitimate telemetry buckets and must NOT be
 * filtered out. Any future sidecar file in this directory should follow
 * the same `__<purpose>.jsonl` convention.
 */
function rotationsFile() {
  return path.join(telemetryDir(), '__session-rotations.jsonl');
}

function readLastObserved() {
  try {
    const raw = fs.readFileSync(lastObservedFile(), 'utf8');
    if (raw.length === 0 || raw.length > 4096) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.id !== 'string' || typeof obj.at !== 'number') return null;
    return obj;
  } catch {
    return null;
  }
}

function writeLastObserved(id, atMs) {
  try {
    fs.mkdirSync(sessionDir(), { recursive: true });
    fs.writeFileSync(lastObservedFile(), JSON.stringify({ id, at: atMs }));
  } catch {
    /* fail-open */
  }
}

function appendRotation(record) {
  try {
    fs.mkdirSync(telemetryDir(), { recursive: true });
    fs.appendFileSync(rotationsFile(), JSON.stringify(record) + '\n');
  } catch {
    /* fail-open */
  }
}

// Module-level flag so we emit the burst warning at most once per process —
// hooks are short-lived (one process per UserPromptSubmit) but we still don't
// want a noisy stderr if some downstream caller hits this twice.
let burstWarningEmitted = false;

function emitBurstWarningOnce(prevId, currentId, deltaMs) {
  if (burstWarningEmitted) return;
  burstWarningEmitted = true;
  try {
    process.stderr.write(
      `[synapsys] CLAUDE_CODE_SESSION_ID rotated in ${deltaMs}ms ` +
        `(prev=${prevId.slice(0, 8)}… next=${currentId.slice(0, 8)}…); ` +
        `expected once-per-conversation cadence. See ${rotationsFile()} for history.\n`
    );
  } catch {
    /* fail-open */
  }
}

/**
 * Record a rotation if `currentId` differs from the last-observed id.
 * Idempotent: same id → no-op. Distinct id → JSONL append + maybe stderr.
 *
 * NOT atomic across processes: the read-then-write between
 * `readLastObserved()` and `writeLastObserved()` can race with a concurrent
 * hook invocation, so under heavy concurrency a rotation row may be
 * double-logged or skipped. This is acceptable for best-effort
 * instrumentation — readers MUST NOT base any anti-bypass or enforcement
 * decision on this signal.
 *
 * @param {string|null|undefined} currentId
 */
function observeRotation(currentId) {
  if (typeof currentId !== 'string' || currentId.length === 0) return;
  if (process.env.SYNAPSYS_SESSION_ROTATION_DISABLED === '1') return;
  const now = Date.now();
  const prev = readLastObserved();
  if (!prev) {
    writeLastObserved(currentId, now);
    return;
  }
  if (prev.id === currentId) return;
  const deltaMs = now - prev.at;
  appendRotation({
    at: new Date(now).toISOString(),
    pid: process.pid,
    prevId: prev.id,
    nextId: currentId,
    prevSeenAt: new Date(prev.at).toISOString(),
    deltaMs,
    fastRotation: deltaMs < FAST_ROTATION_THRESHOLD_MS,
  });
  if (deltaMs < FAST_ROTATION_THRESHOLD_MS && process.env.SYNAPSYS_DEBUG === '1') {
    emitBurstWarningOnce(prev.id, currentId, deltaMs);
  }
  writeLastObserved(currentId, now);
}

function __resetForTests() {
  burstWarningEmitted = false;
}

module.exports = {
  observeRotation,
  rotationsFile,
  lastObservedFile,
  FAST_ROTATION_THRESHOLD_MS,
  __resetForTests,
};
