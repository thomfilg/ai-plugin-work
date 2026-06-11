/**
 * alerts.js — write maestro-facing alerts to two sinks:
 *   1. /tmp/maestro-alerts.jsonl    (structured, one JSON per line)
 *   2. tmux session "maestro-alerts" (human-tailable)
 *
 * Detectors should never call alert() directly; they return findings
 * and the main loop decides when to escalate.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmux = require('./tmux');

const ALERT_FILE = process.env.ALERT_FILE || '/tmp/maestro-alerts.jsonl';
const ALERT_SESSION = process.env.ALERT_SESSION || 'maestro-alerts';
// Must match state.js default so persisted alert counts live alongside the
// per-ticket markers that gate dead-end escalation. Previously defaulted to
// /tmp/maestro-conduct, which diverged from state.js (~/.cache/maestro-conduct)
// and caused repeat counts to be stored in the wrong place.
const STATE_DIR = process.env.STATE_DIR || path.join(os.homedir(), '.cache', 'maestro-conduct');

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
  return `${obj.session || obj.ticket}|${obj.kind}|${obj.sha || obj.phase || '_'}`;
}

function log(line) {
  const ts = new Date().toISOString();
  const out = `[${ts}] ${line}\n`;
  process.stderr.write(out);
  try {
    fs.appendFileSync(process.env.LOG_FILE || '/tmp/maestro-conduct.log', out);
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
// Kinds the operator must act on now (answer a menu, decide on PR, kill a
// wedge). Other kinds are informational reminders the operator can fast-route.
const ACTION_REQUIRED_KINDS = new Set([
  'question-pending',
  'nudges-exhausted',
  'wedged',
  'dead-end',
  'pr-ready',
  'pr-broken',
  'pr-comments-stuck',
]);

function alert(obj) {
  if (!obj || typeof obj.instruction !== 'string' || !obj.instruction.trim()) {
    log(`ALERT-DROPPED (no instruction): ${JSON.stringify(obj)}`);
    return { count: 0 };
  }
  const key = alertKey(obj);
  const count = bumpCount(key);
  const prefix = count > 1 ? `[REPEAT ${count}] ` : '';
  const instruction = `${prefix}${obj.instruction}`;
  // action_required stays true for EVERY repeat of an actionable kind.
  // Earlier behavior set it only on count===1, which let operators tune out
  // [REPEAT N] events as informational — and a brief_gate stall would chain
  // 5-9 menus before dead-end with action_required=false on every one but
  // the first. Now: as long as the kind is in ACTION_REQUIRED_KINDS, the
  // operator sees action_required=true and an explicit unblock command on
  // every emit. Idempotency comes from the operator (re-answering the same
  // menu is harmless), not from us hiding the alert.
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
  log(`ACTION ${JSON.stringify(payload)}`);
  return { count };
}

module.exports = { alert, log, resetCount, alertKey, ALERT_FILE, ALERT_SESSION };
