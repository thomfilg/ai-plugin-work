'use strict';

/**
 * detectors/stuck-input.js — queued-but-never-submitted composer text (GH-449 mode 6).
 *
 * Observed repeatedly in live fleets: `tmux send-keys … Enter` delivers the
 * text but the Enter never registers, so a directive sits in the agent's
 * input box (`❯ Go with B`) for hours while the agent idles. One incident
 * stalled a keystone ticket ~1.5h; another left three agents frozen overnight
 * with operator text stuck in their composers.
 *
 * Detection: the pane's composer line (`❯ <text>`) shows the SAME non-empty
 * text across consecutive ticks while NO live spinner is running (an idle
 * agent with queued input has nothing to wait for). Menu-option cursors
 * (`❯ 1. Yes …`) are excluded — those are question prompts, owned by the
 * question detector.
 *
 * This detector NEVER auto-submits by default: stale composer text is
 * sometimes an instruction the operator deliberately withheld, and pressing
 * Enter would execute it. The main loop emits a `stuck-input` alert carrying
 * the exact text + a copy-paste unstick command; STUCK_INPUT_AUTO_SUBMIT=1
 * opts into automatic End+Enter recovery (for fleets where all queued text
 * comes from the conductor itself).
 */

const state = require('../state');
const paneBusy = require('../pane-busy');
const { LIVE_SPINNER_RE, isCodexPaneDialect } = require('../live-spinner');

// Minutes the same composer text must persist before the detector hits.
const STUCK_INPUT_MIN = parseInt(process.env.STUCK_INPUT_MIN || '5', 10);

// A composer line is `❯` + text. A menu option is `❯ 1. …` — not ours.
const COMPOSER_RE = /^\s*❯\s+(\S.*)$/;
const MENU_OPTION_RE = /^\s*❯\s*\d+\.\s/;

/** Extract the last composer-looking line from the pane, or null. */
function composerText(pane) {
  const lines = pane.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (MENU_OPTION_RE.test(line)) return null; // an open menu owns the cursor
    const m = line.match(COMPOSER_RE);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Mid-turn: a live spinner in the capture OR a live tool subprocess under the
 * pane. Spinner frames scroll out of the capture while subagents run, but the
 * subprocess signal survives — GH-698: a stuck-input alert fired for queued
 * text the SAME tick another detector logged "agent working quietly".
 */
function agentMidTurn(session, pane) {
  return LIVE_SPINNER_RE.test(pane) || paneBusy.paneHasLiveSubprocess(session);
}

function detect({ session, pane, dialect }) {
  // Codex dialects: composer glyph unknown (TUI) or absent entirely (exec
  // stream pane) — "unsupported", never a stuck-input verdict (WP-09).
  if (isCodexPaneDialect(dialect)) return { hit: false, capability: 'unsupported' };
  if (!session || !pane) return { hit: false };
  const text = composerText(pane);
  const prev = state.read(session, 'stuck-input');
  if (!text) {
    if (prev) {
      // Composer emptied — the queued text was submitted or cleared. `cleared`
      // lets the runner retire any pending stuck-input alert (GH-698).
      state.clear(session, 'stuck-input');
      return { hit: false, cleared: true };
    }
    return { hit: false };
  }
  // Mid-turn (or new/changed text): queued text is expected to sit until the
  // turn ends. Restart the idle clock so only post-busy idle time counts
  // toward STUCK_INPUT_MIN — an idle pane with the SAME stuck text is the
  // only anomalous state.
  if (agentMidTurn(session, pane) || !prev || prev.text !== text) {
    state.write(session, 'stuck-input', { text, firstSeenAt: state.now() });
    return { hit: false };
  }
  const mins = state.minutesSince(prev.firstSeenAt);
  if (mins < STUCK_INPUT_MIN) return { hit: false };
  return { hit: true, kind: 'stuck-input', text, elapsedMin: mins };
}

module.exports = { name: 'stuckInput', detect, composerText, STUCK_INPUT_MIN };
