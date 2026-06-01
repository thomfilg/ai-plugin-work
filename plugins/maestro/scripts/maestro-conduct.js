#!/usr/bin/env node
/**
 * maestro-conduct.js — the maestro's active conducting loop.
 *
 * The conductor keeps each player on tempo. For every GH-*-work tmux session:
 *   1. Determine current phase from the /work state file (workstate.js)
 *   2. Look up the detectors registered for this phase (phase-registry.js)
 *   3. Question detection always runs first — if the agent is waiting on
 *      a decision, never nudge it; track pending time and escalate to a
 *      maestro alert if it sits unanswered.
 *   4. Spinner-hang is an immediate interrupt (Esc + cue).
 *   5. Phase-budget stall drives the soft → interrupt → alert chain via
 *      phase-registry.escalationFor().
 *
 * One-shot by default; pass --daemon to loop with TICK_SEC between cycles.
 */
const path = require('path');
const tmux = require('./lib/maestro-conduct/tmux');
const state = require('./lib/maestro-conduct/state');
const workstate = require('./lib/maestro-conduct/workstate');
const { phaseFor, escalationFor } = require('./lib/maestro-conduct/phase-registry');
const actions = require('./lib/maestro-conduct/actions');
const alerts = require('./lib/maestro-conduct/alerts');

const DETECTORS = {
  question: require('./lib/maestro-conduct/detectors/question'),
  silence: require('./lib/maestro-conduct/detectors/silence'),
  spinner: require('./lib/maestro-conduct/detectors/spinner'),
  phaseStall: require('./lib/maestro-conduct/detectors/phase-stall'),
  commitStall: require('./lib/maestro-conduct/detectors/commit-stall'),
  prComments: require('./lib/maestro-conduct/detectors/pr-comments'),
};

// Only -work sessions are restart-eligible (matches maestro-conduct.sh
// gating). Helpers like -dev / -listen are surfaced informationally but
// would re-launch wrong if relaunched as /work <tid>.
function restartEligible(session) {
  return /-work$/.test(session);
}

const REPO_NAME = process.env.REPO_NAME || 'claude-plugin-work';
const Q_WAIT_MIN = parseInt(process.env.Q_WAIT_MIN || '3', 10);
const TICK_SEC = parseInt(process.env.TICK_SEC || '60', 10);

/** Build the context object passed to every detector. */
function ctxFor(session) {
  // Strip the maestro session-suffix (-work / -dev / -listen). Helper sessions
  // still derive a meaningful ticket id — they are surfaced informationally
  // but never auto-restarted (see restartEligible above).
  const ticket = tmux.ticketIdFor(session);
  // Single read so phase and step come from the same on-disk snapshot
  // (the file can be rewritten by /work between reads otherwise).
  const { phase, step } = workstate.snapshot(ticket);
  const worktree = path.join(workstate.WORKTREES_BASE, `${REPO_NAME}-${ticket}`);
  const pane = tmux.capture(session);
  return { session, ticket, phase, step, worktree, pane };
}

function handleQuestion(ctx, qHit) {
  // Question marker is per-SESSION: a `-work` session showing a prompt while
  // an `-dev` helper is idle (or vice versa) must not clobber each other's
  // markers. Multiple sessions can map to the same ticket.
  const prev = state.read(ctx.session, 'question');
  const now = state.now();
  if (!prev) {
    state.write(ctx.session, 'question', { startedAt: now, alerted: false });
    return;
  }
  const mins = state.minutesSince(prev.startedAt);
  if (mins >= Q_WAIT_MIN && !prev.alerted) {
    actions.alert({
      session: ctx.session,
      ticket: ctx.ticket,
      kind: 'question-pending',
      phase: ctx.phase,
      elapsedMin: mins,
      options: qHit.options,
      promptKind: qHit.promptKind,
    });
    state.write(ctx.session, 'question', { startedAt: prev.startedAt, alerted: true });
  }
}

// Healthy "waiting on user" patterns the agent emits to the pane while halted.
// When detected, phase-stall is suppressed — the agent is not stuck.
const HALTED_WAITING_PATTERNS = [
  /awaiting.*merge|wait.*merge|Once you( click| have)? merge/i,
  /Per.*never-auto-merge|won['’]t merge|won['’]t auto-merge/i,
  /CI is green.*[Mm]erge when ready/i,
];

function isHaltedWaitingForUser(pane) {
  if (!pane) return false;
  return HALTED_WAITING_PATTERNS.some((re) => re.test(pane));
}

// Advance a marker after sending a nudge/alert. `alerted=true` flips the
// one-shot flag so subsequent ticks suppress re-alerting until the marker is
// reset (phase advance, HEAD change, etc.).
function bumpMarker(ticket, key, marker, alerted) {
  state.write(ticket, key, {
    ...marker,
    nudges: (marker.nudges || 0) + 1,
    lastNudgeAt: state.now(),
    ...(alerted ? { alerted: true } : {}),
  });
}

function handlePhaseStall(ctx, stallHit) {
  const profile = phaseFor(ctx.phase);
  if (profile.exempts(ctx)) {
    alerts.log(`${ctx.session} phase-stall exempted by registry for phase=${ctx.phase}`);
    return;
  }
  // Suppress when the agent is correctly waiting for a human action (merge, etc.)
  if (isHaltedWaitingForUser(ctx.pane)) {
    alerts.log(
      `${ctx.session} phase-stall suppressed — agent halted waiting for user (phase=${ctx.phase})`
    );
    return;
  }
  const marker = stallHit.marker;
  const sinceLastNudge = marker.lastNudgeAt ? state.minutesSince(marker.lastNudgeAt) : Infinity;
  // Don't re-nudge before the per-phase cooldown.
  if (marker.lastNudgeAt && sinceLastNudge < stallHit.reNudgeMin) return;
  // Once nudges are exhausted AND the one-shot alert has fired, stop re-alerting
  // until the phase actually advances. The marker is reset on phase change inside
  // the phase-stall detector. We must NOT early-return before the alert branch
  // fires, since escalationFor() only returns 'alert' once nudges >= maxNudges.
  if (marker.nudges >= stallHit.maxNudges && marker.alerted) return;

  const escalation = escalationFor(ctx.phase, marker.nudges);
  const reason = `phase=${ctx.phase} stuck ${stallHit.elapsedMin}m budget=${stallHit.budgetMin}m nudge ${marker.nudges + 1}/${stallHit.maxNudges}`;

  if (escalation === 'alert') {
    actions.alert({
      session: ctx.session,
      ticket: ctx.ticket,
      kind: 'nudges-exhausted',
      phase: ctx.phase,
      elapsedMin: stallHit.elapsedMin,
      budgetMin: stallHit.budgetMin,
      nudges: marker.nudges,
    });
  } else if (escalation === 'interrupt') {
    actions.interrupt(ctx.session, reason);
  } else {
    actions.soft(ctx.session, reason);
  }
  bumpMarker(ctx.ticket, 'phase', marker, escalation === 'alert');
}

// Cooldown so spinner interrupts don't repeat every tick and flood the pane.
const SPINNER_RE_INTERRUPT_MIN = parseInt(process.env.SPINNER_RE_INTERRUPT_MIN || '5', 10);

// Spinner hang is an immediate interrupt; doesn't go through nudge counter.
// Returns true ONLY when a fresh interrupt was just sent (caller skips remaining
// detectors so we don't double-message the pane in the same tick). Cooldown
// suppresses the re-interrupt but lets the other detectors keep observing.
function runSpinnerDetector(ctx) {
  const sHit = DETECTORS.spinner.detect(ctx);
  // Spinner marker is per-SESSION: a hung `-work` pane and an idle `-dev`
  // helper share a ticket but have different pane buffers; sharing the
  // marker would let one clear the other's cooldown.
  if (!sHit.hit) {
    if (state.read(ctx.session, 'spinner')) state.clear(ctx.session, 'spinner');
    return false;
  }
  const prev = state.read(ctx.session, 'spinner');
  if (prev && state.minutesSince(prev.lastInterruptAt) < SPINNER_RE_INTERRUPT_MIN) {
    // Within cooldown — already nudged this hang. Stay quiet on the spinner,
    // but let other detectors run; they observe independent signals.
    return false;
  }
  actions.interrupt(ctx.session, `spinner stuck ${sHit.elapsedMin}m: ${sHit.line}`);
  state.write(ctx.session, 'spinner', { lastInterruptAt: state.now() });
  return true;
}

// Silence is a "session is dead" signal; on hit, auto-restart -work sessions
// and clear all per-ticket markers so detectors don't fire against the
// pre-restart state. Returns true when handled so the tick can skip the
// remaining detectors (no point running them against a session we just killed).
function runSilenceDetector(ctx) {
  const sHit = DETECTORS.silence.detect(ctx);
  if (!sHit.hit) return false;
  if (!restartEligible(ctx.session)) {
    // Helper (-dev / -listen) is idle past SILENCE_LIMIT_SEC but we won't kill
    // it. Without resetting the marker, silence would fire every subsequent
    // tick → log spam + short-circuit of other detectors forever. Instead:
    // log once, refresh the marker so the silence timer restarts, and let the
    // remaining detectors run by returning false. Worst case we log again in
    // another SILENCE_LIMIT_SEC, not every tick.
    alerts.log(
      `${ctx.session} AUTO-RESTART skipped: non-work helper session (not restart-eligible)`
    );
    state.write(ctx.session, 'silence', {
      hash: null,
      tokens: null,
      lastActiveAt: state.now(),
    });
    return false;
  }
  const ok = actions.autoRestart({
    session: ctx.session,
    ticket: ctx.ticket,
    worktree: ctx.worktree,
    silenceSec: sHit.silenceSec,
  });
  if (ok) {
    // After a restart, wipe both per-SESSION markers (silence/spinner/question
    // — keyed by session) AND per-TICKET markers (phase/pr-comments — keyed by
    // ticket because the workflow state belongs to the ticket, not the pane).
    ['silence', 'spinner', 'question'].forEach((k) => state.clear(ctx.session, k));
    ['phase', 'pr-comments'].forEach((k) => state.clear(ctx.ticket, k));
  }
  return true;
}

function runPhaseStallDetector(ctx) {
  const pHit = DETECTORS.phaseStall.detect(ctx);
  if (pHit.hit) handlePhaseStall(ctx, pHit);
}

function runCommitStallDetector(ctx) {
  const cHit = DETECTORS.commitStall.detect(ctx);
  if (cHit.hit) alerts.log(`${ctx.session} commit-stall ${cHit.mins}m in phase=${ctx.phase}`);
}

function runPrCommentsDetector(ctx) {
  const cHit = DETECTORS.prComments.detect(ctx);
  if (cHit.hit) handlePrComments(ctx, cHit);
}

/** Run the per-session pipeline. Returns when the session has been fully processed. */
function tickSession(session) {
  const ctx = ctxFor(session);

  // Question always wins — never nudge while the agent is waiting on us.
  const qHit = DETECTORS.question.detect(ctx);
  if (qHit.hit) {
    handleQuestion(ctx, qHit);
    return;
  }
  state.clear(ctx.session, 'question');

  const detectorsToRun = phaseFor(ctx.phase).detectors.filter((k) => k !== 'question');

  // Silence runs before spinner: a totally-dead pane is more urgent than a
  // hung spinner, and the restart wipes spinner state anyway.
  if (detectorsToRun.includes('silence') && runSilenceDetector(ctx)) return;
  if (detectorsToRun.includes('spinner') && runSpinnerDetector(ctx)) return;
  if (detectorsToRun.includes('phaseStall')) runPhaseStallDetector(ctx);
  if (detectorsToRun.includes('commitStall')) runCommitStallDetector(ctx);
  if (detectorsToRun.includes('prComments')) runPrCommentsDetector(ctx);
}

function tick() {
  const sessions = tmux.listSessions();
  if (!sessions.length) {
    alerts.log('no GH-*-work sessions');
    return;
  }
  for (const session of sessions) tickSession(session);
}

function handlePrComments(ctx, cHit) {
  const marker = cHit.marker;
  const sinceLastNudge = marker.lastNudgeAt ? state.minutesSince(marker.lastNudgeAt) : Infinity;
  const profile = phaseFor(ctx.phase);
  // Use the same per-phase re-nudge cooldown so we don't spam.
  if (marker.lastNudgeAt && sinceLastNudge < profile.reNudgeMin) return;

  const nudges = marker.nudges || 0;
  const maxNudges = profile.maxNudges || 3;
  // Once nudges are exhausted AND the one-shot alert has fired, stop re-alerting
  // until HEAD moves or the comments are gone. The detector resets the marker on
  // either change. We must NOT early-return before the alert branch fires, since
  // escalationFor() only returns 'alert' once nudges >= maxNudges.
  if (nudges >= maxNudges && marker.alerted) return;
  const top = cHit.summary
    .map((s) => `${s.file}:${s.line} [${s.severity || '?'}] ${s.title}`)
    .join(' | ');
  const reason = `PR #${cHit.prNumber} has ${cHit.count} unaddressed bot comment(s), HEAD unchanged ${cHit.minsStuck}m. Top: ${top}`;
  const escalation = escalationFor(ctx.phase, nudges);

  if (escalation === 'alert') {
    actions.alert({
      session: ctx.session,
      ticket: ctx.ticket,
      kind: 'pr-comments-stuck',
      phase: ctx.phase,
      prNumber: cHit.prNumber,
      count: cHit.count,
      elapsedMin: cHit.minsStuck,
      summary: cHit.summary,
    });
  } else if (escalation === 'interrupt') {
    actions.interrupt(ctx.session, reason);
  } else {
    actions.soft(ctx.session, reason);
  }
  bumpMarker(ctx.ticket, 'pr-comments', marker, escalation === 'alert');
}

function main() {
  const daemon = process.argv.includes('--daemon');
  if (!daemon) {
    tick();
    return;
  }
  alerts.log(`orchestrate daemon starting, tick=${TICK_SEC}s`);
  setInterval(tick, TICK_SEC * 1000);
  tick();
}

if (require.main === module) main();
module.exports = { tick, ctxFor, restartEligible };
