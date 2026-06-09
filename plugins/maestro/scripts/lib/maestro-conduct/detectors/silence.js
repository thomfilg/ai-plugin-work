/**
 * detectors/silence.js
 *
 * Port of maestro-conduct.sh's silence/auto-restart detection.
 *
 * A pane is "active" only when:
 *   (a) a live Claude thinking-spinner line is visible, OR
 *   (b) the displayed token count went up since last poll, OR
 *   (c) the pane content hash changed since last poll.
 *
 * Static status-bar text alone does NOT count as activity — so a wholly
 * dead/crashed agent is detected even though tmux still considers the
 * pane "alive" (the status bar redraws at idle).
 *
 * On hit, the main loop is expected to call actions.autoRestart for
 * -work sessions (only; helpers like -dev / -listen are surfaced
 * informationally but never relaunched).
 */
const crypto = require('crypto');
const state = require('../state');
const skillRegistry = require('../skill-registry');

// Hard default if neither env override nor registry row provides a limit.
const DEFAULT_SILENCE_LIMIT_SEC = 300;

// Module-level capture is advisory only and kept for backward export
// compatibility. The authoritative limit is resolved per-call by
// `resolveSilenceLimit(ctx)` — see GH-514 Task 4 (R3 / AC4): the
// SILENCE_LIMIT_SEC_FOLLOWUP env var must take effect at detect() time
// without requiring a daemon restart, and follow-up sessions must honor
// the registry's larger default (1800s) instead of the work default.
const SILENCE_LIMIT_SEC = parseInt(
  process.env.SILENCE_LIMIT_SEC || String(DEFAULT_SILENCE_LIMIT_SEC),
  10
);

/**
 * Resolve the silence-limit for a given ctx, per-call.
 *
 * Resolution order (spec §Architecture, AC4; PR #561 review fix):
 *   - follow-up: $SILENCE_LIMIT_SEC_FOLLOWUP → registry row → 300
 *   - work / unknown / missing skill: $SILENCE_LIMIT_SEC → registry row → 300
 *
 * For the work path, $SILENCE_LIMIT_SEC takes precedence over the registry row
 * default so operators upgrading from pre-GH-514 (where $SILENCE_LIMIT_SEC was
 * authoritative) keep their configured threshold. This preserves the "bit-for-
 * bit identical when .maestro-skill is absent" guarantee.
 */
function posInt(v) {
  const n = parseInt(v || '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function resolveSilenceLimit(ctx) {
  const skill = (ctx && ctx.skill) || null;
  if (skill === 'follow-up') {
    const envFollowup = posInt(process.env.SILENCE_LIMIT_SEC_FOLLOWUP);
    if (envFollowup) return envFollowup;
  } else {
    // work / unknown / missing — env override is authoritative (legacy contract).
    const envWork = posInt(process.env.SILENCE_LIMIT_SEC);
    if (envWork) return envWork;
  }
  const row = skill ? skillRegistry.get(skill) : null;
  const rowLimit = row && posInt(row.silenceLimitSec);
  if (rowLimit) return rowLimit;
  return DEFAULT_SILENCE_LIMIT_SEC;
}

// Shared with detectors/spinner.js — see ../live-spinner.js for the contract.
// Both detectors MUST consume the same regex; otherwise one classifies a pane
// as active while the other classifies it as silent, and the escalation chain
// becomes unpredictable for "still running" form spinners.
const { LIVE_SPINNER_RE } = require('../live-spinner');

function paneTokens(pane) {
  if (!pane) return null;
  const matches = pane.match(/(\d+)\s+tokens/g);
  if (!matches || !matches.length) return null;
  const last = matches[matches.length - 1];
  const n = parseInt(last, 10);
  return Number.isFinite(n) ? n : null;
}

function paneHash(pane) {
  return crypto
    .createHash('md5')
    .update(pane || '')
    .digest('hex');
}

function isActive(pane, hashNow, toksNow, prev) {
  if (LIVE_SPINNER_RE.test(pane)) return true;
  if (toksNow !== null && prev.tokens !== null && toksNow !== prev.tokens) return true;
  if (!prev.hash) return true; // first sighting
  if (hashNow !== prev.hash) return true;
  return false;
}

function detect({ session, ticket, pane, skill }) {
  // Marker is keyed by SESSION, not ticket. Multiple sessions share a ticket
  // (-work + -dev + -listen all map to the same ticket id) but each has its
  // own pane content; sharing a marker would cause hash ping-pong and leave
  // every helper falsely "active." Fall back to ticket only if a caller still
  // passes one without a session (older tests do this).
  const key = session || ticket;
  if (!key) return { hit: false };
  if (!pane) {
    return { hit: true, kind: 'session-gone', silenceSec: Infinity, sessionGone: true };
  }

  const hashNow = paneHash(pane);
  const toksNow = paneTokens(pane);
  const now = Math.floor(Date.now() / 1000);

  const raw = state.read(key, 'silence') || {};
  const prev = {
    hash: raw.hash,
    tokens: typeof raw.tokens === 'number' ? raw.tokens : null,
    lastActiveAt: raw.lastActiveAt || 0,
  };

  if (isActive(pane, hashNow, toksNow, prev)) {
    state.write(key, 'silence', { hash: hashNow, tokens: toksNow, lastActiveAt: now });
    return { hit: false };
  }

  const limitSec = resolveSilenceLimit({ skill });
  const silenceSec = now - prev.lastActiveAt;
  if (silenceSec < limitSec) return { hit: false, silenceSec };
  return { hit: true, kind: 'silence', silenceSec, limitSec };
}

/**
 * Format a conductor log line for the silence path with a skill-prefixed
 * token (GH-514 Task 6 / R7). The token shape is:
 *   `[<ticket>:<skill>] <kind>: <silenceSec>s`
 * e.g. `[GH-514:follow-up] silence: 120s`.
 *
 * Operators grep on this token to separate follow-up vs work activity in
 * `/tmp/maestro-conduct.log` without re-parsing the session/session-name.
 * The README's `skill-adapter` section is the single source of truth for
 * this format. Missing `skill` falls back to 'work' so default `/work`
 * log shape stays bit-for-bit unchanged (AC5).
 */
function formatLogLine({ ticket, skill, silenceSec, kind } = {}) {
  const t = ticket || '?';
  const s = skill || 'work';
  const k = kind || 'silence';
  const sec = Number.isFinite(silenceSec) ? `${silenceSec}s` : '?s';
  return `[${t}:${s}] ${k}: ${sec}`;
}

module.exports = { name: 'silence', detect, SILENCE_LIMIT_SEC, resolveSilenceLimit, formatLogLine };
