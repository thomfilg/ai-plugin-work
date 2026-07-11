'use strict';

/**
 * silence-runner.js — the silence detector's runner: dead-pane auto-restart
 * plus its suppression gates. Extracted from detector-runners.js (that file
 * sits at the max-lines gate), same pattern as commit-stall-runner.js and
 * idle-blocked-runner.js. detector-runners re-exports these for the
 * historical module surface.
 */

const state = require('./state');
const alerts = require('./alerts');
const actions = require('./actions');
const paneBusy = require('./pane-busy');
const waitMute = require('./wait-mute');
const { isHaltedWaitingForUser } = require('./halted-waiting');
const idleBlockedRunner = require('./idle-blocked-runner');
const silenceDetector = require('./detectors/silence');

function refreshSilenceMarker(session) {
  state.write(session, 'silence', { hash: null, tokens: null, lastActiveAt: state.now() });
}

/**
 * True when the silent pane must NOT be treated as dead:
 *   - the agent announced it is waiting on a human (merge etc.) — restarting
 *     wipes in-flight gate answers and loops the same questions forever;
 *   - an idle-blocked alert is pending its operator grace window — the pane
 *     is hash-static by construction, so silence claims it too, and a restart
 *     would destroy the very (possibly unparsable) prompt the alert just told
 *     the operator to READ ("Do NOT kill/restart on this signal alone").
 *     Self-heal resumes once the hold lapses (GH-698 A1 review);
 *   - a live tool subprocess (docker build, test run) is working under the
 *     pane — "working quietly" is not "frozen". Operators used to raise
 *     SILENCE_LIMIT_SEC to a day to protect builds, which also disabled all
 *     dead-agent recovery.
 */
function silenceSuppressed(ctx, sHit) {
  if (sHit.kind === 'session-gone') return false;
  if (isHaltedWaitingForUser(ctx.pane)) {
    refreshSilenceMarker(ctx.session);
    waitMute.noteWaitingForUser({ session: ctx.session, phase: ctx.phase, state, alerts });
    return true;
  }
  if (idleBlockedRunner.holdsSilenceRestart(ctx.session)) {
    refreshSilenceMarker(ctx.session);
    alerts.log(
      `${ctx.session} silence deferred: idle-blocked alert pending (operator grace window)`,
      { kind: 'log-only' } // re-checks once per silence window while the hold lasts
    );
    return true;
  }
  if (paneBusy.paneHasLiveSubprocess(ctx.session)) {
    refreshSilenceMarker(ctx.session);
    const busyMark = state.read(ctx.session, 'busy-quiet') || {};
    if (!busyMark.loggedAt || state.minutesSince(busyMark.loggedAt) >= 15) {
      alerts.log(
        `${ctx.session} silence deferred: live tool subprocess under the pane (agent working quietly)`,
        { kind: 'log-only' }
      );
      state.write(ctx.session, 'busy-quiet', { loggedAt: state.now() });
    }
    return true;
  }
  return false;
}

// Silence = "session dead"; on hit, auto-restart -work and clear markers.
// Returns true when handled so the tick skips remaining detectors.
function runSilenceDetector(ctx, { restartEligible }) {
  const sHit = silenceDetector.detect(ctx);
  if (!sHit.hit) return false;
  if (silenceSuppressed(ctx, sHit)) return false;
  if (!restartEligible(ctx.session)) {
    // Helper sessions (-listen / -dev) are inert by design; their idleness
    // carries zero information for the operator. Refresh the marker so the
    // detector doesn't re-fire each tick, but emit nothing.
    refreshSilenceMarker(ctx.session);
    return false;
  }
  const ok = actions.autoRestart({
    session: ctx.session,
    ticket: ctx.ticket,
    worktree: ctx.worktree,
    silenceSec: sHit.silenceSec,
    runtime: ctx.runtime,
  });
  if (ok) {
    // After a restart, wipe both per-SESSION markers (silence/spinner/question
    // /idle-blocked — keyed by session) AND per-TICKET markers (phase/
    // pr-comments/dead-end — keyed by ticket because the workflow state
    // belongs to the ticket, not the pane). Clearing `dead-end` restores the
    // probe entitlement: every lifecycle gets a diagnostic probe before any
    // kill, and an autoRestart starts a new lifecycle just like an operator
    // bootstrap does. (A `killed` dead-end never reaches here —
    // checkDeadEndGuard blocks the restart first — so only stale `diagnosed`
    // markers are wiped.)
    ['silence', 'spinner', 'question', 'idle-blocked', 'idle-blocked-alert'].forEach((k) =>
      state.clear(ctx.session, k)
    );
    // The wipe above removes the markers every alerts.resolve('idle-blocked')
    // path is gated on — retire a pending incident explicitly, or its banner
    // entry survives the restart un-resolvable and the next real incident
    // inherits [REPEAT N] (GH-698 review).
    alerts.resolve(ctx.session, 'idle-blocked', 'session auto-restarted');
    ['phase', 'pr-comments', 'dead-end'].forEach((k) => state.clear(ctx.ticket, k));
    return true;
  }
  // autoRestart skipped (wedged quiet window, ci-gate-freed, dead-end, fresh
  // progress, or missing worktree) — pane is still alive and listed, so let
  // downstream detectors (notably prStatus) keep emitting state transitions.
  return false;
}

module.exports = { runSilenceDetector, silenceSuppressed, refreshSilenceMarker };
