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
  // A cleared incident must re-wake immediately if it recurs.
  resetThrottle(key);
}
function alertKey(obj) {
  // Flatten the "<ns>/" segment so persisted alert-count keys stay flat
  // (`<ticket>[-suffix]|kind|…`) and maestro-cleanup's bare-id purge matcher
  // finds them under MAESTRO_NS (GH-622).
  return `${namespace.flattenKey(obj.session || obj.ticket)}|${obj.kind}|${obj.sha || obj.phase || '_'}`;
}

// Kinds the operator must act on now (answer a menu, decide on PR, kill a
// wedge). Other kinds are informational reminders the operator can fast-route.
// NOTE: membership here also sets action_required=true on the alert payload,
// which stop-guard treats as stop-blocking — do NOT add "maybe do nothing"
// kinds (spinner-hang, no-progress) to THIS set; they belong only in
// DEFAULT_WAKE_KINDS below.
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

// Default CONDUCT_WAKE_EVENTS allowlist: every kind whose alert needs a
// conductor/operator response and has NO self-healing escalation path.
// Superset of ACTION_REQUIRED_KINDS plus:
//   spinner-hang / no-progress — never escalate to dead-end and never
//     self-heal (SPINNER_AUTO_INTERRUPT is opt-in); silent = a frozen agent
//     holds its pool slot forever.
//   kill-during-ci / stop-condition-met — slot-rotation outcomes carrying the
//     bootstrap-next instruction; silent = the pool quietly drains.
// Must stay in sync with PENDING_KINDS in hooks/active-session-reminder.js
// (asserted by wake-kinds-invariant in __tests__/heartbeat-wake-routing.test.js)
// and with the CONDUCT_WAKE_EVENTS default in config-schema.json.
const DEFAULT_WAKE_KINDS = new Set([
  ...ACTION_REQUIRED_KINDS,
  'spinner-hang',
  'no-progress',
  'kill-during-ci',
  'stop-condition-met',
]);

// Kind for informational log lines that must never wake the conductor model
// (they still land in the logfile). Not in any wake set by construction.
const KIND_LOG_ONLY = 'log-only';

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
    return { all: false, kinds: DEFAULT_WAKE_KINDS };
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

// ── Re-wake throttle (GH-680 12h-no-compact budget) ─────────────────────────
// Every conductor wake permanently grows the transcript, so repeats of the
// SAME pending alert must not each cost a model turn: the first emission of a
// key wakes immediately; repeats re-wake only after an exponential backoff
// (PENDING_REWAKE_MIN, doubling per re-wake, capped at PENDING_REWAKE_MAX_MIN).
// Nothing is lost: every repeat still lands in the jsonl + tmux pane + banner
// re-fire, and each wake's UserPromptSubmit banner re-surfaces ALL pending
// alerts — the throttle only bounds how often an UNHANDLED alert re-bills
// the context window. PENDING_REWAKE_MIN=0 or CONDUCT_WAKE_EVENTS=all
// restores wake-on-every-repeat.
const THROTTLE_FILE = path.join(STATE_DIR, '_wake-throttle.json');
function rewakeMinutes() {
  const n = parseInt(process.env.PENDING_REWAKE_MIN || '30', 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}
function rewakeMaxMinutes() {
  const n = parseInt(process.env.PENDING_REWAKE_MAX_MIN || '240', 10);
  return Number.isFinite(n) && n > 0 ? n : 240;
}
function loadThrottle() {
  try {
    const obj = JSON.parse(fs.readFileSync(THROTTLE_FILE, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}
function saveThrottle(map) {
  try {
    // Hygiene: drop entries idle for 2× the max backoff — keys rotate with
    // sha/phase so stale ones would otherwise accumulate forever.
    const horizon = 2 * rewakeMaxMinutes() * 60 * 1000;
    const now = Date.now();
    for (const k of Object.keys(map)) {
      if (!map[k] || now - (map[k].lastWakeAt || 0) > horizon) delete map[k];
    }
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // tmp+rename so a torn read can never wipe sibling backoff state.
    const tmp = `${THROTTLE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(map));
    fs.renameSync(tmp, THROTTLE_FILE);
  } catch {}
}

/**
 * Decide whether this emission of `key` may hit the wake channel, and record
 * the wake when it does. First emission always wakes; subsequent ones wake
 * only after the current backoff window, which doubles on every re-wake.
 * Fail-open: any state error allows the wake (losing a wake is worse than
 * paying one).
 *
 * @param {string} key alertKey(obj)
 * @returns {boolean} true when this emission should wake
 */
function rewakeGate(key) {
  const baseMin = rewakeMinutes();
  if (baseMin === 0) return true; // throttle disabled
  const { all } = parseWakeEvents();
  if (all) return true; // firehose mode: operator asked for everything
  try {
    const map = loadThrottle();
    const now = Date.now();
    const entry = map[key];
    if (entry && now - entry.lastWakeAt < entry.backoffMin * 60 * 1000) {
      return false; // still inside the backoff window — logged, not woken
    }
    const nextBackoff = entry
      ? Math.min(entry.backoffMin * 2, rewakeMaxMinutes())
      : baseMin;
    map[key] = { lastWakeAt: now, backoffMin: nextBackoff };
    saveThrottle(map);
    return true;
  } catch {
    return true;
  }
}

/** Clear the throttle entry for a key so a fresh incident re-wakes immediately. */
function resetThrottle(key) {
  try {
    const map = loadThrottle();
    if (key in map) {
      delete map[key];
      saveThrottle(map);
    }
  } catch {}
}

/**
 * Fault-channel log with repeat backoff (GH-680 review): the un-kinded log()
 * form always wakes, which is right for the FIRST occurrence of a daemon
 * fault (TICK-ERROR, sync failures, FLEET-EMPTY) but bills a wake per tick
 * while the fault persists. Route repeats through the same rewakeGate under a
 * synthetic `_fault|` key: first occurrence wakes immediately, repeats wake
 * on the doubling backoff. The logfile always gets every line.
 *
 * @param {string} line
 * @param {string} faultKey stable identity of the fault (e.g. `tick-error|<session>`)
 */
function logFault(line, faultKey) {
  log(line, { noWake: !rewakeGate(`_fault|${faultKey}`) });
}

/**
 * Append a line to the logfile and, when the line's `kind` is wake-eligible,
 * also write it to process.stderr (the conductor's model-wake channel).
 *
 * Backward compatible: the positional single-arg form `log(line)` still writes
 * to stderr unconditionally (no kind ⇒ legacy always-wake; reserved for real
 * faults like TICK-ERROR/DAEMON-CRASH). Pass `log(line, { kind })` to gate the
 * stderr write through wakesConductor(kind) — a non-waking kind (HEARTBEAT,
 * 'log-only' info lines) is logged to the file but suppressed on stderr
 * (GH-680). `opts.noWake` suppresses stderr regardless of kind — used by
 * alert() when the re-wake throttle swallows a repeat.
 *
 * @param {string} line
 * @param {{ kind?: string, noWake?: boolean }} [opts]
 */
function log(line, opts) {
  const ts = new Date().toISOString();
  const out = `[${ts}] ${line}\n`;
  const kind = opts && opts.kind;
  const noWake = opts && opts.noWake === true;
  if (!noWake && (kind === undefined || wakesConductor(kind))) {
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
  // New-incident guarantee (GH-680 review): counts and incidents are reset
  // together (resetCount, purgeAlertCountsForTicket), so count===1 is the
  // authoritative "fresh incident" signal. Clear any stale throttle entry —
  // keys without a sha (kill-during-ci, stop-condition-met) repeat verbatim
  // across lifecycles and must never inherit an old backoff window.
  if (count === 1) resetThrottle(key);
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
  // Wake decision (GH-680): the kind must be in the CONDUCT_WAKE_EVENTS
  // allowlist AND this key must clear the re-wake throttle. Repeats inside
  // the backoff window are logged (jsonl + tmux + logfile) but do not bill a
  // conductor turn — the banner re-fire keeps them visible until handled.
  const throttled = wakesConductor(obj.kind) && !rewakeGate(key);
  log(`ACTION ${JSON.stringify(payload)}`, { kind: obj.kind, noWake: throttled });
  return { count };
}

module.exports = {
  alert,
  log,
  logFault,
  wakesConductor,
  resetCount,
  alertKey,
  ALERT_FILE,
  ALERT_SESSION,
  DEFAULT_WAKE_KINDS,
  ACTION_REQUIRED_KINDS,
  KIND_LOG_ONLY,
};
