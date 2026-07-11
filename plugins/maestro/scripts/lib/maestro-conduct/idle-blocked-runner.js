'use strict';

/**
 * idle-blocked-runner.js — per-session runner for detectors/idle-blocked.js
 * (GH-698 A1). Own module (not detector-runners.js) for the same reason as
 * commit-stall-runner.js: that file sits at the max-lines gate.
 *
 * Policy layer: phase exemptions, announced-human-wait suppression, alert
 * cadence, and resolve-on-clear. The pane-signature mechanics live in the
 * detector. ALERT-ONLY — never kills/restarts; auto-acting on an idle
 * heuristic is exactly the class of action that destroyed in-flight work in
 * past incidents.
 */

const state = require('./state');
const alerts = require('./alerts');
const actions = require('./actions');
const { isHaltedWaitingForUser } = require('./halted-waiting');
const idleBlockedDetector = require('./detectors/idle-blocked');

// Alert-record cadence only — the BLOCKING re-wake throttle separately bounds
// how often repeats bill a conductor turn.
const IDLE_BLOCKED_RE_EMIT_MIN = parseInt(process.env.IDLE_BLOCKED_RE_EMIT_MIN || '15', 10);

// Operator grace window: while an idle-blocked alert is pending, the silence
// auto-restart is held (silence-runner.js) so the possibly-unparsable prompt
// survives long enough to be read. Measured from the FIRST alert of the
// incident — the re-emit cadence refreshes lastAt, so keying on lastAt would
// hold forever and disable self-heal entirely.
const IDLE_BLOCKED_HOLD_MIN = parseInt(process.env.IDLE_BLOCKED_HOLD_MIN || '30', 10);

// Phases where an idle pane is by design (awaiting merge, CI, done). Mirrors
// NO_PROGRESS_EXEMPT_PHASES in detector-runners.js — keep the two in sync.
const IDLE_BLOCKED_EXEMPT_PHASES = new Set(['complete', 'wait_merge', 'ci', 'cleanup', 'reports']);

/** True while a pending idle-blocked alert is inside its restart-hold window. */
function holdsSilenceRestart(session) {
  const marker = state.read(session, 'idle-blocked-alert');
  if (!marker || !marker.firstAlertAt) return false;
  return state.minutesSince(marker.firstAlertAt) < IDLE_BLOCKED_HOLD_MIN;
}

/** True when a confirmed hit already alerted inside IDLE_BLOCKED_RE_EMIT_MIN. */
function reEmitCoolingDown(session) {
  const marker = state.read(session, 'idle-blocked-alert') || {};
  return Boolean(marker.lastAt && state.minutesSince(marker.lastAt) < IDLE_BLOCKED_RE_EMIT_MIN);
}

/** On the detector's one-shot `cleared` tick, retire the pending incident. */
function retireIfCleared(session, hit) {
  if (!hit.cleared) return;
  state.clear(session, 'idle-blocked-alert');
  alerts.resolve(session, 'idle-blocked', hit.clearedBy || 'agent active again');
}

function runIdleBlockedDetector(ctx, { restartEligible }) {
  if (!restartEligible(ctx.session)) return;
  const hit = idleBlockedDetector.detect(ctx);
  if (!hit.hit) {
    retireIfCleared(ctx.session, hit);
    return;
  }
  if (IDLE_BLOCKED_EXEMPT_PHASES.has(ctx.phase) || isHaltedWaitingForUser(ctx.pane)) {
    // Idle is healthy here — drop the streak and retire any pending alert, so
    // leaving this state requires a fresh N-tick confirmation and elapsedMin
    // never spans a benign wait (GH-698 review: a scrolled-out wait banner or
    // a phase exit used to fire instantly off hours of accumulated ticks).
    noteSiblingOwned(ctx.session, 'idle is healthy here (exempt phase or announced wait)');
    return;
  }
  if (reEmitCoolingDown(ctx.session)) return;
  const prevAlert = state.read(ctx.session, 'idle-blocked-alert') || {};
  state.write(ctx.session, 'idle-blocked-alert', {
    lastAt: state.now(),
    firstAlertAt: prevAlert.firstAlertAt || state.now(),
  });
  const unblockCmd = `tmux capture-pane -t ${ctx.session} -p | tail -40`;
  actions.alert({
    session: ctx.session,
    ticket: ctx.ticket,
    kind: 'idle-blocked',
    phase: ctx.phase,
    skill: ctx.skill,
    elapsedMin: hit.elapsedMin,
    ticks: hit.ticks,
    paneTail: (ctx.pane || '').split('\n').slice(-40).join('\n'),
    unblockCmd,
    instruction:
      `agent has sat idle-blocked ${hit.elapsedMin}m (${hit.ticks} ticks): empty composer, no spinner, no tool subprocess, mid-workflow (phase=${ctx.phase}) — ` +
      'usually a prompt the question detector cannot parse (permission/trust/login dialog) or a turn that ended without the workflow advancing. ' +
      `READ the pane first: ${unblockCmd}. Visible prompt → answer it in the pane. ` +
      'No prompt → nudge the agent to continue its workflow. Do NOT kill/restart on this signal alone ' +
      `(auto-restart is held ${IDLE_BLOCKED_HOLD_MIN}m from the first alert, then self-heal resumes).`,
  });
}

/**
 * A sibling detector took ownership of the pane this tick (the main loop
 * short-circuits on a question hit, so detect() never runs to re-arm
 * itself). Drop the tick counter — the idle streak is broken — and retire
 * any pending idle-blocked alert. No-op when nothing was armed.
 */
function noteSiblingOwned(session, why) {
  if (state.read(session, 'idle-blocked')) state.clear(session, 'idle-blocked');
  if (state.read(session, 'idle-blocked-alert')) {
    state.clear(session, 'idle-blocked-alert');
    alerts.resolve(session, 'idle-blocked', why);
  }
}

module.exports = {
  runIdleBlockedDetector,
  noteSiblingOwned,
  holdsSilenceRestart,
  IDLE_BLOCKED_EXEMPT_PHASES,
  IDLE_BLOCKED_HOLD_MIN,
};
