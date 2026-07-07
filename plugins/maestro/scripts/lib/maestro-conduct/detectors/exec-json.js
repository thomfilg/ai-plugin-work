'use strict';

/**
 * detectors/exec-json.js — aliveness/silence detection for fleet-launched
 * codex agents from their `codex exec --json` event stream (design C14/§H).
 *
 * Bootstrap/restart tee the stream to `<state>/<ticket>.exec.jsonl`; this
 * detector never reads the tmux pane. Signals (probe-verified shapes,
 * /tmp/codex-probe-logs/exec1-envprobe.jsonl):
 *   - bytes appended since last tick  → alive
 *   - `{"type":"turn.completed","usage":{input_tokens,…}}` → turn/progress +
 *     token accounting (surfaced for pulse/alerts)
 *   - process exit is NOT visible in the stream — it surfaces as the tmux
 *     session dying, which the silence detector's runtime-neutral
 *     `session-gone` leg already reports before delegating here.
 *
 * Return shape mirrors detectors/silence.js ({hit, kind:'silence',
 * silenceSec, limitSec}) so runSilenceDetector's restart path works
 * unchanged for exec fleets. A missing stream file yields
 * `{hit:false, capability:'no-stream'}` — fail-open, never a restart verdict
 * on absent evidence.
 */

const fs = require('fs');
const state = require('../state');

// Marker kind under state.js — separate from 'silence' so a dialect flip
// (claude relaunch after a codex run, or vice versa) can't inherit a stale
// lastActiveAt from the other detector's bookkeeping.
const MARKER = 'exec-json';

const BYPASS_WARNING_RE = /--dangerously-bypass-hook-trust/;

function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const total =
    (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0) +
    (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0);
  return total > 0 ? total : null;
}

function foldEvent(info, event) {
  if (!event || typeof event.type !== 'string') return;
  info.lastEventType = event.type;
  if (event.type === 'turn.completed') {
    info.turnsCompleted += 1;
    const tokens = usageTokens(event.usage);
    if (tokens !== null) info.lastTokens = tokens;
  }
  const item = event.item;
  if (item && item.type === 'error' && BYPASS_WARNING_RE.test(String(item.message || ''))) {
    // §H: the bypass flag emits visible warning items — their presence is the
    // conductor's confirmation that hooks actually ran on this agent.
    info.hookTrustBypassed = true;
  }
}

/**
 * Parse a teed `--json` stream. Returns { turnsCompleted, lastTokens,
 * lastEventType, hookTrustBypassed, unavailable? } — tolerant of partial
 * trailing lines (tee mid-write) and non-JSON noise.
 */
function readStreamInfo(execLog) {
  const info = {
    turnsCompleted: 0,
    lastTokens: null,
    lastEventType: null,
    hookTrustBypassed: false,
  };
  let raw;
  try {
    raw = fs.readFileSync(execLog, 'utf8');
  } catch {
    info.unavailable = true;
    return info;
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      foldEvent(info, JSON.parse(line));
    } catch {
      /* partial/garbled line — skip */
    }
  }
  return info;
}

/** Stream size in bytes, or null when the path is unset/unreadable. */
function statSize(execLog) {
  if (!execLog) return null;
  try {
    return fs.statSync(execLog).size;
  } catch {
    return null;
  }
}

/** Previous {size, lastActiveAt} observation for a marker key. */
function readMarker(key) {
  const raw = state.read(key, MARKER) || {};
  return {
    size: typeof raw.size === 'number' ? raw.size : null,
    lastActiveAt: raw.lastActiveAt || 0,
  };
}

/**
 * Silence detection over the stream file. `limitSec` is injected by the
 * silence detector (resolveSilenceLimit) so env/skill overrides keep one
 * source of truth. Marker keyed by session (falls back to ticket) like
 * detectors/silence.js.
 */
function detect({ session, ticket, execLog, limitSec }) {
  const key = session || ticket;
  if (!key) return { hit: false };
  const size = statSize(execLog);
  if (size === null) return { hit: false, capability: 'no-stream' };

  const now = state.now();
  const prev = readMarker(key);

  // First sighting or bytes appended → alive. A shrunken file (rotated or
  // truncated stream) also refreshes the marker rather than counting as
  // silence against a stale offset.
  if (prev.size === null || size !== prev.size) {
    state.write(key, MARKER, { size, lastActiveAt: now });
    return { hit: false };
  }

  const limit = limitSec || 300;
  const silenceSec = now - prev.lastActiveAt;
  if (silenceSec < limit) return { hit: false, silenceSec };

  const stream = readStreamInfo(execLog);
  return {
    hit: true,
    kind: 'silence',
    silenceSec,
    limitSec: limit,
    turnsCompleted: stream.turnsCompleted,
    lastEventType: stream.lastEventType,
  };
}

module.exports = { name: 'execJson', detect, readStreamInfo, MARKER };
