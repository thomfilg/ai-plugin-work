'use strict';

/**
 * detectors/idle-blocked.js — catch-all for the question-detection gap
 * (GH-698 A1): an agent whose pane shows an EMPTY idle composer (`❯` with no
 * text), no live spinner, and no live tool subprocess is waiting on
 * SOMETHING — most often a prompt whose grammar the question detector does
 * not know (permission prompts for plain bash have sat 44+ minutes exactly
 * this way), a trust/login dialog, or a turn that ended without the workflow
 * advancing. The regex detectors are all pattern-positive: an unrecognized
 * prompt reads as "nothing happening" forever. This detector is the
 * pattern-NEGATIVE backstop: idle-shaped and unexplained ⇒ wake the operator.
 *
 * The idle signature must persist Q_IDLE_CONFIRM_TICKS consecutive conductor
 * ticks before the detector hits — a single idle tick is routine (a tick can
 * land between a turn ending and the workflow continuing it).
 *
 * Ownership boundaries (checked in this order — this detector claims only
 * what no sibling already owns):
 *   - recognized question prompt  → detectors/question.js
 *   - live spinner                → detectors/spinner.js (agent mid-turn)
 *   - composer WITH queued text   → detectors/stuck-input.js
 *   - no composer at all          → detectors/silence.js (dead/foreign pane)
 *   - live tool subprocess        → agent working quietly, not blocked
 *
 * Never auto-acts: the runner emits an `idle-blocked` alert (BLOCKING tier)
 * and the operator inspects the pane. Killing/restarting on this heuristic
 * alone is exactly the class of auto-action that has destroyed in-flight
 * work in past incidents.
 */

const state = require('../state');
const paneBusy = require('../pane-busy');
const question = require('./question');
const { LIVE_SPINNER_RE, isCodexPaneDialect } = require('../live-spinner');

// Consecutive question-free idle ticks before the detector hits. At the
// default TICK_SEC=60 the confirmation window is ~3 minutes.
const Q_IDLE_CONFIRM_TICKS = parseInt(process.env.Q_IDLE_CONFIRM_TICKS || '3', 10);

// The last `❯`-cursor line decides composer state: bare cursor = idle
// composer (ours), trailing text = queued input (stuck-input's), absent =
// not a recognizable agent TUI (silence detector's).
const CURSOR_LINE_RE = /^\s*❯/;
const EMPTY_COMPOSER_RE = /^\s*❯\s*$/;

/** Bottom-most `❯` line, or null when the pane shows no composer cursor. */
function lastCursorLine(pane) {
  const lines = pane.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (CURSOR_LINE_RE.test(lines[i])) return lines[i];
  }
  return null;
}

/**
 * The reason this pane is NOT ours to claim (busy, or owned by a sibling
 * detector), or null when the idle-blocked signature holds. Checked in
 * sibling-ownership order — see the module header.
 */
function ownedOrBusyReason({ session, pane, dialect }) {
  // A recognized prompt is the question detector's. The main loop returns
  // before reaching us on a hit — this guard covers out-of-order callers.
  if (question.detect({ pane, dialect }).hit) return 'question prompt visible';
  if (LIVE_SPINNER_RE.test(pane)) return 'live spinner';
  const cursor = lastCursorLine(pane);
  if (cursor === null) return 'no composer visible';
  if (!EMPTY_COMPOSER_RE.test(cursor)) return 'composer has queued text';
  if (paneBusy.paneHasLiveSubprocess(session)) return 'live tool subprocess';
  return null;
}

/**
 * Not idle-blocked (or not ours): drop any armed marker and tell the runner
 * ONCE so it can retire a pending alert (mirrors stuck-input's `cleared`).
 */
function rearm(session, clearedBy) {
  if (state.read(session, 'idle-blocked')) {
    state.clear(session, 'idle-blocked');
    return { hit: false, cleared: true, clearedBy };
  }
  return { hit: false };
}

function detect({ session, pane, dialect }) {
  // Codex dialects: composer/spinner grammar is claude-TUI-only (WP-09) —
  // report "unsupported", never an idle verdict on unreadable evidence.
  if (isCodexPaneDialect(dialect)) return { hit: false, capability: 'unsupported' };
  if (!session || !pane) return { hit: false };
  const reason = ownedOrBusyReason({ session, pane, dialect });
  if (reason) return rearm(session, reason);

  const prev = state.read(session, 'idle-blocked') || { ticks: 0, firstSeenAt: state.now() };
  const marker = { ticks: prev.ticks + 1, firstSeenAt: prev.firstSeenAt };
  state.write(session, 'idle-blocked', marker);
  if (marker.ticks < Q_IDLE_CONFIRM_TICKS) return { hit: false };
  return {
    hit: true,
    kind: 'idle-blocked',
    ticks: marker.ticks,
    elapsedMin: state.minutesSince(marker.firstSeenAt),
  };
}

module.exports = { name: 'idleBlocked', detect, lastCursorLine, Q_IDLE_CONFIRM_TICKS };
