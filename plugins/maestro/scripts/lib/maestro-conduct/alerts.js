/**
 * alerts.js — write maestro-facing alerts to two sinks:
 *   1. /tmp/maestro-alerts.jsonl    (structured, one JSON per line)
 *   2. tmux session "maestro-alerts" (human-tailable)
 *
 * Detectors should never call alert() directly; they return findings
 * and the main loop decides when to escalate.
 */
const fs = require('fs');
const path = require('path');
const tmux = require('./tmux');
const namespace = require('./namespace');

const ALERT_FILE = namespace.alertFile();
const ALERT_SESSION = namespace.alertSession();
// Must match state.js so persisted alert counts live alongside the per-ticket
// markers that gate dead-end escalation. Both flow through namespace.stateDir()
// so a MAESTRO_NS run keeps counts in its own per-namespace subdir (GH-622).
const STATE_DIR = namespace.stateDir();

// In-process emit counter keyed by `${session}|${kind}|${sha||phase}`. Cleared
// by the caller (typically via freeDeadEndSlot or phase advance). Persisted to
// disk in STATE_DIR/_alert-counts.json so a daemon restart doesn't lose count.
const COUNT_FILE = path.join(STATE_DIR, '_alert-counts.json');
function loadCounts() {
  try {
    return JSON.parse(fs.readFileSync(COUNT_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveCounts(counts) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(COUNT_FILE, JSON.stringify(counts));
  } catch {}
}
function bumpCount(key) {
  const counts = loadCounts();
  counts[key] = (counts[key] || 0) + 1;
  saveCounts(counts);
  return counts[key];
}
function resetCount(key) {
  const counts = loadCounts();
  if (key in counts) {
    delete counts[key];
    saveCounts(counts);
  }
}
function alertKey(obj) {
  // Flatten the "<ns>/" segment so persisted alert-count keys stay flat
  // (`<ticket>[-suffix]|kind|…`) and maestro-cleanup's bare-id purge matcher
  // finds them under MAESTRO_NS (GH-622).
  return `${namespace.flattenKey(obj.session || obj.ticket)}|${obj.kind}|${obj.sha || obj.phase || '_'}`;
}

// Kinds the operator must act on now (answer a menu, decide on PR, kill a
// wedge). Other kinds are informational reminders the operator can fast-route.
// Declared before wakesConductor() so it can serve as the default wake set.
const ACTION_REQUIRED_KINDS = new Set([
  'question-pending',
  'nudges-exhausted',
  'wedged',
  'dead-end',
  'dead-end-probe',
  'pr-ready',
  'pr-broken',
  'pr-comments-stuck',
  'comment-loop',
  'stuck-input',
  'auth-broken',
]);

/**
 * Resolve the CONDUCT_WAKE_EVENTS allowlist (GH-680). The single wake channel
 * is process.stderr.write in log(); only kinds in this set are allowed to hit
 * it, so benign HEARTBEATs update state/log/statusline without waking the
 * conductor model. Parsing is comma-split + trim, fail-closed for unknown
 * kinds; `all`/`*` restores the pre-680 always-wake behavior.
 *
 * @returns {{ all: boolean, kinds: Set<string> }}
 */
function parseWakeEvents() {
  const raw = process.env.CONDUCT_WAKE_EVENTS;
  if (raw == null || raw.trim() === '') {
    return { all: false, kinds: ACTION_REQUIRED_KINDS };
  }
  const tokens = raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.includes('all') || tokens.includes('*')) {
    return { all: true, kinds: new Set() };
  }
  return { all: false, kinds: new Set(tokens) };
}

/**
 * True iff an alert of `kind` may wake the conductor model (write to the
 * stderr wake channel). Unknown kinds never match (fail-closed); the `all`/`*`
 * escape hatch wakes on every kind. Read fresh each call so an env change (or
 * a test reloading the module) takes effect without a restart.
 *
 * @param {string} kind
 * @returns {boolean}
 */
function wakesConductor(kind) {
  const { all, kinds } = parseWakeEvents();
  return all || kinds.has(kind);
}

/**
 * Append a line to the logfile and, when the line's `kind` is wake-eligible,
 * also write it to process.stderr (the conductor's model-wake channel).
 *
 * Backward compatible: the positional single-arg form `log(line)` still writes
 * to stderr unconditionally (no kind ⇒ legacy always-wake). Pass
 * `log(line, { kind })` to gate the stderr write through wakesConductor(kind)
 * — a non-waking kind (e.g. HEARTBEAT under the default allowlist) is logged
 * to the file but suppressed on stderr (GH-680).
 *
 * @param {string} line
 * @param {{ kind?: string }} [opts]
 */
function log(line, opts) {
  const ts = new Date().toISOString();
  const out = `[${ts}] ${line}\n`;
  const kind = opts && opts.kind;
  if (kind === undefined || wakesConductor(kind)) {
    process.stderr.write(out);
  }
  try {
    fs.appendFileSync(namespace.logFile(), out);
  } catch {}
}

/**
 * Emit an action-required alert. Refuses payloads without an `instruction`
 * field — informational events must use log() instead. The operator should
 * be able to read the instruction and execute it without further context.
 *
 * Expected shape:
 *   {
 *     session, ticket, kind,        // identity
 *     ...event-specific fields,     // sha, prNumber, options, etc.
 *     instruction: '...',           // REQUIRED — exact action to take
 *   }
 *
 * The tmux summary line embeds the kind + instruction so it's grep-friendly
 * and self-explanatory in the maestro-alerts pane.
 *
 * Returns { count } — the number of times this same (session, kind,
 * sha-or-phase) has been emitted since last reset. The caller must check
 * the count and escalate when it crosses a threshold (typically auto-call
 * freeDeadEndSlot at count >= 3). The instruction string gets a [REPEAT N]
 * prefix when count > 1 so the operator can see momentum.
 */
function alert(obj) {
  if (!obj || typeof obj.instruction !== 'string' || !obj.instruction.trim()) {
    log(`ALERT-DROPPED (no instruction): ${JSON.stringify(obj)}`);
    return { count: 0 };
  }
  const key = alertKey(obj);
  const count = bumpCount(key);
  const prefix = count > 1 ? `[REPEAT ${count}] ` : '';
  const instruction = `${prefix}${obj.instruction}`;
  // action_required stays true for EVERY repeat of an actionable kind (PR
  // #603). Earlier behavior set it only on count===1, which let operators
  // tune out [REPEAT N] events as informational — a brief_gate stall would
  // chain 5-9 menus before dead-end with action_required=false on every one
  // but the first. Idempotency comes from the operator (re-answering the same
  // menu is harmless), not from hiding the alert.
  const actionRequired = ACTION_REQUIRED_KINDS.has(obj.kind);
  const payload = {
    ts: new Date().toISOString(),
    ...obj,
    instruction,
    repeatCount: count,
    action_required: actionRequired,
  };
  try {
    fs.appendFileSync(ALERT_FILE, JSON.stringify(payload) + '\n');
  } catch {}
  tmux.ensureSession(ALERT_SESSION);
  const summary = `ACTION ${obj.session || obj.ticket || '?'} kind=${obj.kind} → ${instruction}`;
  tmux.sendLine(ALERT_SESSION, summary);
  // Pass the kind so the closing wake-channel write is gated by the
  // CONDUCT_WAKE_EVENTS allowlist — actionable kinds stay wake-eligible while
  // non-allowlisted kinds are logged only (GH-680).
  log(`ACTION ${JSON.stringify(payload)}`, { kind: obj.kind });
  return { count };
}

module.exports = {
  alert,
  log,
  wakesConductor,
  resetCount,
  alertKey,
  ALERT_FILE,
  ALERT_SESSION,
};
