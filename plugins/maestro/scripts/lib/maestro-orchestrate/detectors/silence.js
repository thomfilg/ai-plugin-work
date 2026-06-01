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

const SILENCE_LIMIT_SEC = parseInt(process.env.SILENCE_LIMIT_SEC || '300', 10);

// Matches Claude TUI live spinner lines, e.g.:
//   "✻ Jitterbugging… (3s · thinking with medium effort)"
//   "* Hashing… (37s · ↓ 7.4k tokens)"
// Always paired with a leading bullet/spinner glyph AND the ellipsis variant.
const LIVE_SPINNER_RE = /^[●○◯•*✻✶✢·✽✣✤✱⏵⏶]\s+[A-Z][a-z]+…\s*\(/m;

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

function detect({ ticket, pane }) {
  if (!ticket) return { hit: false };
  if (!pane) {
    return { hit: true, kind: 'session-gone', silenceSec: Infinity, sessionGone: true };
  }

  const hashNow = paneHash(pane);
  const toksNow = paneTokens(pane);
  const now = Math.floor(Date.now() / 1000);

  const raw = state.read(ticket, 'silence') || {};
  const prev = {
    hash: raw.hash,
    tokens: typeof raw.tokens === 'number' ? raw.tokens : null,
    lastActiveAt: raw.lastActiveAt || 0,
  };

  if (isActive(pane, hashNow, toksNow, prev)) {
    state.write(ticket, 'silence', { hash: hashNow, tokens: toksNow, lastActiveAt: now });
    return { hit: false };
  }

  const silenceSec = now - prev.lastActiveAt;
  if (silenceSec < SILENCE_LIMIT_SEC) return { hit: false, silenceSec };
  return { hit: true, kind: 'silence', silenceSec, limitSec: SILENCE_LIMIT_SEC };
}

module.exports = { name: 'silence', detect, SILENCE_LIMIT_SEC };
