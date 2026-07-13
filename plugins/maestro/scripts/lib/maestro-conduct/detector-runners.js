'use strict';

/**
 * detector-runners.js — per-session runner functions for the conductor's
 * heuristic detectors (spinner, silence, stuck-input, no-progress,
 * phase-stall). Extracted from maestro-conduct.js to keep that file under the
 * max-lines gate; behavior lives here, orchestration order stays in the
 * conductor.
 *
 * Shared design rule (GH-627 lite): every ACTIVITY heuristic is gated on the
 * PROGRESS signal (progress.js) — an agent whose worktree is changing is
 * working, however its pane looks, and must not be nudged/interrupted/
 * restarted.
 */

const tmux = require('./tmux');
const state = require('./state');
const alerts = require('./alerts');
const actions = require('./actions');
const progress = require('./progress');
const waitMute = require('./wait-mute');
const silenceRunner = require('./silence-runner');
const { phaseFor, escalationFor } = require('./phase-registry');
const { isHaltedWaitingForUser } = require('./halted-waiting');

const spinnerDetector = require('./detectors/spinner');
const stuckInputDetector = require('./detectors/stuck-input');
const authBrokenDetector = require('./detectors/auth-broken');

const SPINNER_RE_INTERRUPT_MIN = parseInt(process.env.SPINNER_RE_INTERRUPT_MIN || '5', 10);
// Esc-on-spinner-hang is OPT-IN (SPINNER_AUTO_INTERRUPT=1). The blind Esc
// repeatedly cancelled legitimate long operations — 15-17m calibration runs,
// docker builds, a 45m CI wait — destroying in-flight tool calls. Default is
// a structured `spinner-hang` alert: the operator inspects and decides.
const SPINNER_AUTO_INTERRUPT = process.env.SPINNER_AUTO_INTERRUPT === '1';

// stuck-input: text sitting unsubmitted in an idle agent's composer. Default
// is alert-only — stale composer text is sometimes an instruction the
// operator deliberately withheld, so auto-pressing Enter could execute an
// unwanted directive. STUCK_INPUT_AUTO_SUBMIT=1 opts into End+C-m recovery.
const STUCK_INPUT_AUTO_SUBMIT = process.env.STUCK_INPUT_AUTO_SUBMIT === '1';
const STUCK_INPUT_RE_EMIT_MIN = parseInt(process.env.STUCK_INPUT_RE_EMIT_MIN || '15', 10);

// no-progress: the inverse of the silence detector. A pane that keeps
// redrawing (tail -f, polling loop, spinner frames) defeats pane-hash
// silence detection forever — agents have sat 15+ hours "active" with a
// frozen TUI and nobody noticed. This is the backstop: worktree unchanged
// for NO_PROGRESS_ALERT_MIN while the session is supposedly working.
const NO_PROGRESS_ALERT_MIN = parseInt(process.env.NO_PROGRESS_ALERT_MIN || '45', 10);
const NO_PROGRESS_RE_EMIT_MIN = parseInt(process.env.NO_PROGRESS_RE_EMIT_MIN || '60', 10);
// Mirrored by IDLE_BLOCKED_EXEMPT_PHASES in idle-blocked-runner.js — keep in sync.
const NO_PROGRESS_EXEMPT_PHASES = new Set(['complete', 'wait_merge', 'ci', 'cleanup', 'reports']);

// Nudge-storm cap: past 2× the phase's nudge ladder the escalation has
// clearly failed — repeating it only desensitizes the operator (observed:
// 59 nudges + 56 identical alerts on one ticket over ~23h).
const NUDGE_STORM_MUTE_MIN = parseInt(process.env.NUDGE_STORM_MUTE_MIN || '60', 10);

function paneTail(ctx, lines = 40) {
  return (ctx.pane || '').split('\n').slice(-lines).join('\n');
}

// Advance marker after a nudge/alert; `alerted=true` flips the one-shot flag.
function bumpMarker(ticket, key, marker, alerted) {
  state.write(ticket, key, {
    ...marker,
    nudges: (marker.nudges || 0) + 1,
    lastNudgeAt: state.now(),
    ...(alerted ? { alerted: true } : {}),
  });
}

// ── Spinner ─────────────────────────────────────────────────────────────────

function emitSpinnerHangAlert(ctx, sHit) {
  actions.alert({
    session: ctx.session,
    ticket: ctx.ticket,
    kind: 'spinner-hang',
    phase: ctx.phase,
    skill: ctx.skill,
    elapsedMin: sHit.elapsedMin,
    line: sHit.line,
    paneTail: paneTail(ctx),
    instruction:
      `spinner has run ${sHit.elapsedMin}m with no worktree change ("${sHit.line}"). ` +
      'Legit long ops (builds, test suites, calibration runs) look identical to hangs — read paneTail before acting. ' +
      `Confirmed hang → break it: tmux send-keys -t ${ctx.session} Escape, then tell the agent what to retry. ` +
      'Legit long op → do nothing; this alert re-emits on cooldown.',
  });
}

// Spinner hang → progress-gated escalation. Returns true only when an actual
// interrupt was sent so the caller skips remaining detectors this tick.
function runSpinnerDetector(ctx) {
  const sHit = spinnerDetector.detect(ctx);
  // Spinner marker is per-SESSION: a hung `-work` pane and an idle `-dev`
  // helper share a ticket but have different pane buffers; sharing the
  // marker would let one clear the other's cooldown.
  if (!sHit.hit) {
    if (state.read(ctx.session, 'spinner')) {
      state.clear(ctx.session, 'spinner');
      alerts.resolve(ctx.session, 'spinner-hang', 'spinner cleared');
    }
    return false;
  }
  // A spinner with a CHANGING worktree is a long-running tool doing real work
  // — exactly what the elapsed-time heuristic cannot distinguish from a hang.
  if (progress.hasFreshProgress(ctx.ticket)) return false;
  const prev = state.read(ctx.session, 'spinner');
  if (prev && state.minutesSince(prev.lastInterruptAt) < SPINNER_RE_INTERRUPT_MIN) {
    // Within cooldown — already acted on this hang. Stay quiet on the spinner,
    // but let other detectors run; they observe independent signals.
    return false;
  }
  state.write(ctx.session, 'spinner', { lastInterruptAt: state.now() });
  if (SPINNER_AUTO_INTERRUPT) {
    actions.interrupt(
      ctx.session,
      `spinner stuck ${sHit.elapsedMin}m: ${sHit.line}`,
      ctx.skill,
      ctx.dialect
    );
    return true;
  }
  emitSpinnerHangAlert(ctx, sHit);
  return false;
}

// ── Silence ─────────────────────────────────────────────────────────────────
// Runner + suppression gates live in silence-runner.js (max-lines gate);
// re-exported below so the historical module surface survives.

// ── Stuck input ─────────────────────────────────────────────────────────────

function runStuckInputDetector(ctx, { restartEligible }) {
  if (!restartEligible(ctx.session)) return;
  const hit = stuckInputDetector.detect(ctx);
  if (!hit.hit) {
    if (hit.cleared) {
      // Composer emptied — the queued text was submitted or cleared. Retire the
      // pending alert so banners stop resurfacing a resolved incident (GH-698).
      state.clear(ctx.session, 'stuck-input-alert');
      alerts.resolve(ctx.session, 'stuck-input', 'composer cleared');
    }
    return;
  }
  const marker = state.read(ctx.session, 'stuck-input-alert') || {};
  if (marker.lastAt && state.minutesSince(marker.lastAt) < STUCK_INPUT_RE_EMIT_MIN) return;
  state.write(ctx.session, 'stuck-input-alert', { lastAt: state.now() });
  if (STUCK_INPUT_AUTO_SUBMIT) {
    tmux.sendKey(ctx.session, 'End');
    tmux.sendKey(ctx.session, 'C-m');
    alerts.log(
      `${ctx.session} STUCK-INPUT auto-submitted after ${hit.elapsedMin}m: "${hit.text.slice(0, 60)}"`,
      { kind: 'log-only' } // self-heal: the daemon already submitted the input
    );
    return;
  }
  actions.alert({
    session: ctx.session,
    ticket: ctx.ticket,
    kind: 'stuck-input',
    phase: ctx.phase,
    skill: ctx.skill,
    elapsedMin: hit.elapsedMin,
    text: hit.text,
    instruction:
      `text has sat unsubmitted in the agent's composer for ${hit.elapsedMin}m: "${hit.text.slice(0, 120)}". ` +
      `Intended → submit it: tmux send-keys -t ${ctx.session} C-m. ` +
      `Stale/unwanted → clear it: tmux send-keys -t ${ctx.session} C-u. ` +
      'Unsubmitted directives have silently stalled agents for hours — do not ignore.',
  });
}

// ── Auth broken ─────────────────────────────────────────────────────────────

const AUTH_BROKEN_RE_EMIT_MIN = parseInt(process.env.AUTH_BROKEN_RE_EMIT_MIN || '30', 10);

function runAuthBrokenDetector(ctx, { restartEligible }) {
  if (!restartEligible(ctx.session)) return;
  const hit = authBrokenDetector.detect(ctx);
  if (!hit.hit) {
    if (state.read(ctx.session, 'auth-broken')) {
      state.clear(ctx.session, 'auth-broken');
      alerts.resolve(ctx.session, 'auth-broken', 'credential failure no longer visible');
    }
    return;
  }
  const marker = state.read(ctx.session, 'auth-broken') || {};
  if (marker.lastAt && state.minutesSince(marker.lastAt) < AUTH_BROKEN_RE_EMIT_MIN) return;
  state.write(ctx.session, 'auth-broken', { lastAt: state.now() });
  actions.alert({
    session: ctx.session,
    ticket: ctx.ticket,
    kind: 'auth-broken',
    phase: ctx.phase,
    skill: ctx.skill,
    line: hit.line,
    paneTail: paneTail(ctx),
    unblockCmd: `git -C ${ctx.worktree} config user.email && gh auth status`,
    instruction:
      `agent pane shows a credential failure: "${hit.line}". The gh active account flaps across concurrent agents and stale tokens leak via tmux global env — every gh/git call in this worktree may be failing. ` +
      'Verify the expected account (repo wrapper ../.envrc pins it), fix auth (gh auth switch / refresh GH_TOKEN in the pane env), then tell the agent to retry its last command.',
  });
}

// ── No-progress ─────────────────────────────────────────────────────────────

function noProgressExempt(ctx, prog) {
  if (prog.sig === null) return true; // git unreadable — no verdict
  if (NO_PROGRESS_EXEMPT_PHASES.has(ctx.phase)) return true;
  if (isHaltedWaitingForUser(ctx.pane)) return true;
  return prog.minutesSinceChange < NO_PROGRESS_ALERT_MIN;
}

function runNoProgressCheck(ctx, prog, { restartEligible }) {
  if (!restartEligible(ctx.session)) return;
  if (prog.changed) {
    if (state.read(ctx.ticket, 'no-progress')) {
      state.clear(ctx.ticket, 'no-progress');
      alerts.resolve(ctx.session, 'no-progress', 'worktree progressing again');
    }
    return;
  }
  if (noProgressExempt(ctx, prog)) return;
  const marker = state.read(ctx.ticket, 'no-progress') || {};
  if (marker.lastAlertAt && state.minutesSince(marker.lastAlertAt) < NO_PROGRESS_RE_EMIT_MIN) {
    return;
  }
  state.write(ctx.ticket, 'no-progress', { lastAlertAt: state.now() });
  actions.alert({
    session: ctx.session,
    ticket: ctx.ticket,
    kind: 'no-progress',
    phase: ctx.phase,
    skill: ctx.skill,
    elapsedMin: prog.minutesSinceChange,
    paneTail: paneTail(ctx),
    instruction:
      `worktree unchanged for ${prog.minutesSinceChange}m while the pane looks active — the agent may be looping, frozen behind a redrawing pane, or waiting on something silently. ` +
      'Read paneTail: legit wait (CI poll, long download) → do nothing. ' +
      `Frozen/looping → interact: tmux send-keys -t ${ctx.session} Escape, ask for a one-line status, restart only if it does not respond.`,
  });
}

// ── Phase stall ─────────────────────────────────────────────────────────────

/** True when this over-budget phase must not be nudged this tick. */
function phaseStallSuppressed(ctx, stallHit, marker, sinceLastNudge) {
  const profile = phaseFor(ctx.phase);
  if (profile.exempts(ctx)) {
    alerts.log(`${ctx.session} phase-stall exempted by registry for phase=${ctx.phase}`, {
      kind: 'log-only', // fires every tick while the phase is exempt
    });
    return true;
  }
  // Suppress when the agent is correctly waiting for a human action (merge, etc.)
  if (isHaltedWaitingForUser(ctx.pane)) {
    waitMute.noteWaitingForUser({ session: ctx.session, phase: ctx.phase, state, alerts });
    return true;
  }
  // Progress gate: a phase over budget whose worktree is still changing is a
  // WORKING agent (slow ≠ stuck). Nudging it interrupts real work.
  if (progress.hasFreshProgress(ctx.ticket)) {
    alerts.log(
      `${ctx.session} phase-stall suppressed: worktree changed <${progress.PROGRESS_FRESH_MIN}m ago (phase=${ctx.phase} ${stallHit.elapsedMin}m over budget but progressing)`,
      { kind: 'log-only' } // fires every tick while over-budget-but-progressing
    );
    return true;
  }
  // Don't re-nudge before the per-phase cooldown.
  if (marker.lastNudgeAt && sinceLastNudge < stallHit.reNudgeMin) return true;
  // Nudge-storm cap (see NUDGE_STORM_MUTE_MIN above).
  if (marker.nudges >= stallHit.maxNudges * 2 && sinceLastNudge < NUDGE_STORM_MUTE_MIN) return true;
  return false;
}

function handlePhaseStall(ctx, stallHit, { maybeEscalateToDeadEnd }) {
  const marker = stallHit.marker;
  const sinceLastNudge = marker.lastNudgeAt ? state.minutesSince(marker.lastNudgeAt) : Infinity;
  if (phaseStallSuppressed(ctx, stallHit, marker, sinceLastNudge)) return;
  // Re-emit on reNudgeMin cadence so alert count grows to DEAD_END_REEMITS
  // (marker resets on phase change, so re-emits stop naturally on advance).
  const escalation = escalationFor(ctx.phase, marker.nudges);
  const reason = `phase=${ctx.phase} stuck ${stallHit.elapsedMin}m budget=${stallHit.budgetMin}m nudge ${marker.nudges + 1}/${stallHit.maxNudges}`;

  if (escalation === 'alert') {
    const r = actions.alert({
      session: ctx.session,
      ticket: ctx.ticket,
      kind: 'nudges-exhausted',
      phase: ctx.phase,
      skill: ctx.skill,
      command: ctx.command || null,
      commandBrief: ctx.commandBrief || null,
      elapsedMin: stallHit.elapsedMin,
      budgetMin: stallHit.budgetMin,
      nudges: marker.nudges,
      paneTail: paneTail(ctx),
      instruction: `phase=${ctx.phase} ${stallHit.elapsedMin}m/${stallHit.budgetMin}m. Agent runs /${ctx.skill || 'work'} (commandBrief field has its summary). UNBLOCK-PROTOCOL: bad artifact (tasks.md/brief.md) usually root cause, NOT missing work. Pane tail in paneTail field.`,
    });
    maybeEscalateToDeadEnd(ctx, 'nudges-exhausted', r.count, ctx.phase);
  } else if (escalation === 'interrupt') {
    actions.interrupt(ctx.session, reason, ctx.skill, ctx.dialect);
  } else {
    actions.soft(ctx.session, reason, ctx.skill, ctx.dialect);
  }
  bumpMarker(ctx.ticket, 'phase', marker, escalation === 'alert');
}

module.exports = {
  runSpinnerDetector,
  runSilenceDetector: silenceRunner.runSilenceDetector,
  runStuckInputDetector,
  runAuthBrokenDetector,
  runNoProgressCheck,
  handlePhaseStall,
  bumpMarker,
  phaseStallSuppressed,
  silenceSuppressed: silenceRunner.silenceSuppressed,
};
