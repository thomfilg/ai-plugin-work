/**
 * detectors/spinner.js
 *
 * Claude TUI emits a one-line spinner WHILE a tool/subagent is RUNNING:
 *   "✻ Synthesizing… (40m 35s · ↓ 78.2k tokens)"
 *   "* Cooked for 1m 57s · 1 monitor still running"
 *   "✽ Frosting… (43m 22s)"
 *
 * Every live spinner line shares two markers:
 *   - a leading glyph from the rotating spinner set (●○◯•*✻✶✢·✽✣✤✱⏵⏶)
 *   - either an ellipsis form ("Verbing…") or a "still running" tail
 *
 * Post-completion summary lines like "Cooked for 40m 35s" appear AFTER a tool
 * finishes — no glyph, no "still running". Matching them would treat finished
 * work as a hang. The leading-glyph guard mirrors the silence detector's
 * LIVE_SPINNER_RE so both detectors agree on what "spinning" means.
 *
 * If the elapsed time on a live spinner line crosses THRESHOLD_MIN, the inner
 * subagent is almost certainly hung. The conductor misses this because
 * spinner frame updates count as pane output (no tmux silence).
 *
 * Returns { hit:true, kind:'spinner-hang', elapsedMin, line } on hit.
 */
const THRESHOLD_MIN = parseInt(process.env.SPINNER_THRESHOLD_MIN || '15', 10);

// Shared with detectors/silence.js — see ../live-spinner.js for the contract.
// Single source of truth so the two detectors can't drift on what counts as
// "spinning" (drift makes silence auto-restart fire on a session the spinner
// detector still considers active, and vice versa).
const { LIVE_SPINNER_RE } = require('../live-spinner');

// Match a trailing elapsed-time token like "40m 35s" or "1h 5m".
const TIMER_RE = /(?:(\d+)h\s+)?(\d+)m(?:\s+(\d+)s)?/;

function elapsedMinFromLine(line) {
  const m = line.match(TIMER_RE);
  if (!m) return 0;
  const h = parseInt(m[1] || '0', 10);
  const mm = parseInt(m[2] || '0', 10);
  return h * 60 + mm;
}

function detect({ pane }) {
  if (!pane) return { hit: false };
  const lines = pane.split('\n').filter((l) => LIVE_SPINNER_RE.test(l));
  if (!lines.length) return { hit: false };
  const last = lines[lines.length - 1];
  const elapsedMin = elapsedMinFromLine(last);
  if (elapsedMin >= THRESHOLD_MIN) {
    return { hit: true, kind: 'spinner-hang', elapsedMin, line: last.trim() };
  }
  return { hit: false };
}

module.exports = { name: 'spinner', detect };
