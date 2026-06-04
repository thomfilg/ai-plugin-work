/**
 * live-spinner.js — single source of truth for the live-spinner pane pattern.
 *
 * Both detectors/silence.js (decides whether the pane is "active") and
 * detectors/spinner.js (decides whether a spinner has been live too long)
 * MUST agree on what counts as a live spinner. If they disagree the
 * escalation chain breaks: a line treated as idle by silence triggers
 * auto-restart before the spinner detector's gentler Esc+nudge can fire.
 *
 * A live Claude TUI spinner line has all of:
 *   - leading bullet/spinner glyph (rotates through SPINNER_GLYPHS)
 *   - a gerund verb form ending in -ing
 *     (NOT past tense; "Cooked for 40m" is a completion summary, not a spinner)
 *   - either the ellipsis-with-timer variant (`… (40m 35s · …)`)
 *     or the "still running" tail (`Verbing for 1m still running`)
 *
 * Mirrors the bash original pane_has_live_spinner from the deleted
 * maestro-conduct.sh.
 */

const SPINNER_GLYPHS = '●○◯•*✻✶✢·✽✣✤✱⏵⏶';

// Source: glyph + space + gerund + (ellipsis-with-paren OR "still running")
const LIVE_SPINNER_SRC =
  `^[${SPINNER_GLYPHS}]\\s+[A-Z][a-z]+ing` + `(?:…\\s*\\([0-9]+[mh]|.*still running)`;

// Multi-line flag so detectors can scan a whole pane buffer.
const LIVE_SPINNER_RE = new RegExp(LIVE_SPINNER_SRC, 'm');

module.exports = { LIVE_SPINNER_RE, LIVE_SPINNER_SRC, SPINNER_GLYPHS };
