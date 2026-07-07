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

// ── Pane dialects (WP-09, design §H) ────────────────────────────────────────
// The patterns above describe the CLAUDE TUI only. Codex sessions come in two
// dialects, neither of which these regexes can read:
//   'codex-exec-json'         — fleet agents; evidence lives in the teed
//                               `--json` stream (detectors/exec-json.js)
//   'codex-tui-conservative'  — operator-attached codex TUI panes; the glyph
//                               grammar is UNKNOWN until the capture harness
//                               (maestro-capture-fixtures.sh) collects real
//                               fixtures, so pane detectors must return
//                               {hit:false, capability:'unsupported'} — never
//                               an idle/restart verdict on glyph evidence.
// An undefined dialect means "claude" (every pre-WP-09 caller), keeping the
// claude paths byte-identical.
const CODEX_PANE_DIALECTS = new Set(['codex-exec-json', 'codex-tui-conservative']);

function isCodexPaneDialect(dialect) {
  return CODEX_PANE_DIALECTS.has(dialect);
}

/** The live-spinner regex for a dialect, or null when the dialect has none. */
function liveSpinnerReFor(dialect) {
  return isCodexPaneDialect(dialect) ? null : LIVE_SPINNER_RE;
}

module.exports = {
  LIVE_SPINNER_RE,
  LIVE_SPINNER_SRC,
  SPINNER_GLYPHS,
  CODEX_PANE_DIALECTS,
  isCodexPaneDialect,
  liveSpinnerReFor,
};
