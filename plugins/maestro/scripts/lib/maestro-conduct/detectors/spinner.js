/**
 * detectors/spinner.js
 *
 * Claude TUI emits a one-line spinner while a tool/subagent runs:
 *   "✻ Synthesizing… (40m 35s · ↓ 78.2k tokens)"
 *   "* Cooked for 1m 57s · 1 monitor still running"
 *   "✽ Frosting… (43m 22s)"
 *
 * If the elapsed time on that line crosses THRESHOLD_MIN, the inner
 * subagent is almost certainly hung. The conductor misses this because
 * spinner frame updates count as pane output (no tmux silence).
 *
 * Returns { hit:true, kind:'spinner-hang', elapsedMin, line } on hit.
 */
const THRESHOLD_MIN = parseInt(process.env.SPINNER_THRESHOLD_MIN || '15', 10);

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
  // Spinner lines end with the timer in parens; bare "Cooked for 1m" is also common.
  const lines = pane.split('\n').filter(l => /…\s*\([0-9]+[mh]/.test(l) || /[A-Z][a-z]+ed for \d+m/.test(l));
  if (!lines.length) return { hit: false };
  const last = lines[lines.length - 1];
  const elapsedMin = elapsedMinFromLine(last);
  if (elapsedMin >= THRESHOLD_MIN) {
    return { hit: true, kind: 'spinner-hang', elapsedMin, line: last.trim() };
  }
  return { hit: false };
}

module.exports = { name: 'spinner', detect };
