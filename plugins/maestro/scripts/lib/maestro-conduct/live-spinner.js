/**
 * live-spinner.js — single source of truth for "what counts as a live Claude
 * TUI spinner line".
 *
 * Both detectors/silence.js and detectors/spinner.js consume this regex so the
 * two never drift. (They used to drift: spinner.js accepted a "still running"
 * tail variant that silence.js missed, which made the silence detector
 * classify a still-running-but-no-hash-change pane as inactive and auto-restart
 * before the gentler spinner Esc+nudge ever fired.)
 *
 * A live spinner line requires THREE anchors:
 *   - a leading bullet/spinner glyph from the rotating set
 *   - a gerund verb form (-ing) — not past tense like "Cooked"
 *   - EITHER the ellipsis + (timer …) paren block ("Verbing… (40m 35s)")
 *     OR a ".*still running" tail emitted while a parallel job is in flight
 *
 * Lines that miss any anchor (no glyph, past tense, no timer/no still-running)
 * signal completed work, not a live spinner.
 *
 * Mirrors the original maestro-conduct.sh pane_has_live_spinner contract
 * (glyph + gerund + ellipsis + paren), generalized to also accept the
 * "still running" tail the TUI emits in parallel-job mode.
 */
const SPINNER_GLYPHS = '●○◯•*✻✶✢·✽✣✤✱⏵⏶';

const LIVE_SPINNER_RE = new RegExp(
  `^[${SPINNER_GLYPHS}]\\s+[A-Z][a-z]+ing(?:…\\s*\\([0-9]+[mh]|.*still running)`,
  'm'
);

module.exports = { LIVE_SPINNER_RE, SPINNER_GLYPHS };
