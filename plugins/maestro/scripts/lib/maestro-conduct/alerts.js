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
const throttle = require('./rewake-throttle');

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
  //
  // Third segment precedence: alertId > sha > phase. `alertId` is an optional
  // caller-provided incident identity for kinds where sha/phase is too coarse
  // — question-pending content-hashes the prompt (GH-698 A4: two DIFFERENT
  // prompts in the same phase used to collapse under one key, so the second
  // inherited the first's repeat count and throttle window). Consumers only
  // ever prefix-match up to `|kind|`, so the segment is opaque to them.
  return `${namespace.flattenKey(obj.session || obj.ticket)}|${obj.kind}|${obj.alertId || obj.sha || obj.phase || '_'}`;
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
  'idle-blocked',
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
//   commit-stall — a multi-hour no-commit stall used to be a log line + a
//     heartbeat flag only; an 8h stall ran to term with the operator never
//     woken (GH-698). High-threshold crossings alert via the main loop.
// Must stay in sync with PENDING_KINDS in hooks/active-session-reminder.js
// (asserted by wake-kinds-invariant in __tests__/heartbeat-wake-routing.test.js)
// and with the CONDUCT_WAKE_EVENTS default in config-schema.json.
const DEFAULT_WAKE_KINDS = new Set([
  ...ACTION_REQUIRED_KINDS,
  'spinner-hang',
  'no-progress',
  'kill-during-ci',
  'stop-condition-met',
  'commit-stall',
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

// ── Re-wake throttle (GH-680, tiered per GH-698) ────────────────────────────
// Persistence + tier mechanics live in rewake-throttle.js. This wrapper maps
// an alert kind to its tier: BLOCKING (ACTION_REQUIRED_KINDS — the agent is
// idle-waiting on the operator) re-wakes on a flat BLOCKING_REWAKE_MIN
// cadence; everything else backs off exponentially per PENDING_REWAKE_MIN.
function rewakeGate(key, kind) {
  return throttle.rewakeGate(key, {
    blocking: kind !== undefined && ACTION_REQUIRED_KINDS.has(kind),
    firehose: parseWakeEvents().all,
  });
}

/** Clear the throttle entry for a key so a fresh incident re-wakes immediately. */
function resetThrottle(key) {
  throttle.resetThrottle(key);
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
  const throttled = wakesConductor(obj.kind) && !rewakeGate(key, obj.kind);
  log(`ACTION ${JSON.stringify(payload)}`, { kind: obj.kind, noWake: throttled });
  return { count };
}

/**
 * Retire every pending alert of (session-or-ticket, kind): purge the persisted
 * repeat counts and throttle entries for ALL sha/phase variants of the key,
 * and append an `alert-resolved` record to the alert file so the banner stops
 * re-surfacing the incident (GH-698: a resolved stuck-input kept re-firing as
 * a PENDING DECISION for its full 90m window while the agent worked on).
 *
 * No-op (returns false, writes nothing) when nothing was pending — callers may
 * invoke this every tick on the "condition absent" path without spamming the
 * sink. Never wakes: resolution is good news.
 *
 * @param {string} sessionOrTicket
 * @param {string} kind the alert kind being resolved (e.g. 'stuck-input')
 * @param {string} [note] short human-readable cause ("composer cleared")
 * @returns {boolean} true when a pending incident was actually retired
 */
function resolve(sessionOrTicket, kind, note) {
  if (!sessionOrTicket || !kind) return false;
  const prefix = `${namespace.flattenKey(sessionOrTicket)}|${kind}|`;
  const countsCleared = throttle.purgeKeysWithPrefix(loadCounts, saveCounts, prefix);
  const throttleCleared = throttle.purgePrefix(prefix);
  if (!countsCleared && !throttleCleared) return false;
  const record = {
    ts: new Date().toISOString(),
    kind: 'alert-resolved',
    session: sessionOrTicket,
    resolvesKind: kind,
    ...(note ? { note } : {}),
  };
  try {
    fs.appendFileSync(ALERT_FILE, JSON.stringify(record) + '\n');
  } catch {}
  log(`${sessionOrTicket} RESOLVED ${kind}${note ? ` (${note})` : ''}`, { kind: KIND_LOG_ONLY });
  return true;
}

module.exports = {
  alert,
  log,
  logFault,
  resolve,
  wakesConductor,
  resetCount,
  alertKey,
  ALERT_FILE,
  ALERT_SESSION,
  DEFAULT_WAKE_KINDS,
  ACTION_REQUIRED_KINDS,
  KIND_LOG_ONLY,
};
