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
const heartbeat = require('./lib/maestro-conduct/heartbeat');

const ciGate = require('./lib/maestro-conduct/ci-gate-rotation');
const waitMute = require('./lib/maestro-conduct/wait-mute');
const prStatusPayload = require('./lib/maestro-conduct/pr-status-payload');
const prCommentsHandler = require('./lib/maestro-conduct/pr-comments-handler');
const questionHandler = require('./lib/maestro-conduct/question-handler');

const DETECTORS = {
  question: require('./lib/maestro-conduct/detectors/question'),
  silence: require('./lib/maestro-conduct/detectors/silence'),
  spinner: require('./lib/maestro-conduct/detectors/spinner'),
  phaseStall: require('./lib/maestro-conduct/detectors/phase-stall'),
  commitStall: require('./lib/maestro-conduct/detectors/commit-stall'),
  prComments: require('./lib/maestro-conduct/detectors/pr-comments'),
  prStatus: require('./lib/maestro-conduct/detectors/pr-status'),
};

// Heartbeat: emit on state-change, with a max-staleness cap so the operator
// always gets a positive signal every HEARTBEAT_MAX_MIN even if nothing has
// changed (proves the daemon is alive). State-change beats include any of:
// activeCount, wedgedCount, prReady/prBroken/prPending counts, ticket set.
//
// HEARTBEAT_MIN was previously a hard floor that suppressed ALL beats in the
// first 15m, including real state changes — which contradicted the
// "state-change-driven" contract (review feedback). It now only rate-limits
// max-staleness (unchanged-body) beats; a real state change emits
// immediately regardless of when the last beat was.
const HEARTBEAT_MIN = parseInt(process.env.HEARTBEAT_MIN || '15', 10); // min gap between two UNCHANGED-state beats
const HEARTBEAT_MAX_MIN = parseInt(process.env.HEARTBEAT_MAX_MIN || '60', 10); // force-emit cap
let lastHeartbeatAt = 0;
let lastHeartbeatBody = '';

// Re-emit escalation: when the same (session, kind, sha/phase) alert fires
// this many times, auto-rotate the slot via freeDeadEndSlot.
const DEAD_END_REEMITS = parseInt(process.env.DEAD_END_REEMITS || '3', 10);

function maybeEscalateToDeadEnd(ctx, kind, repeatCount, sha) {
  if (repeatCount < DEAD_END_REEMITS || ['wait_merge', 'ci', 'complete'].includes(ctx.phase))
    return;
  actions.freeDeadEndSlot({
    session: ctx.session,
    ticket: ctx.ticket,
    kind,
    repeatCount,
    sha,
  });
}

// Only -work sessions restart-eligible (matches maestro-conduct.sh gating).
// Re-exported from heartbeat.js so module.exports keeps the historical surface.
const restartEligible = heartbeat.restartEligible;

const REPO_NAME = process.env.REPO_NAME || 'claude-plugin-work';
const Q_WAIT_MIN = parseInt(process.env.Q_WAIT_MIN || '3', 10);
const TICK_SEC = parseInt(process.env.TICK_SEC || '60', 10);

/** Build the context object passed to every detector. */
function ctxFor(session) {
  // Strip session-suffix to derive ticket id. -dev/-listen are informational only;
  // restartEligible() gates auto-restart to -work. Snapshot is a single on-disk read.
  const ticket = tmux.ticketIdFor(session);
  const { phase, step } = workstate.snapshot(ticket);
  const worktree = path.join(workstate.WORKTREES_BASE, `${REPO_NAME}-${ticket}`);
  const pane = tmux.capture(session);
  return { session, ticket, phase, step, worktree, pane };
}

function handleQuestion(ctx, qHit) {
  questionHandler.handleQuestion({
    ctx,
    qHit,
    state,
    actions,
    qWaitMin: Q_WAIT_MIN,
    maybeEscalateToDeadEnd,
  });
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

// Advance marker after a nudge/alert; `alerted=true` flips the one-shot flag.
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
    waitMute.noteWaitingForUser({ session: ctx.session, phase: ctx.phase, state, alerts });
    return;
  }
  const marker = stallHit.marker;
  const sinceLastNudge = marker.lastNudgeAt ? state.minutesSince(marker.lastNudgeAt) : Infinity;
  // Don't re-nudge before the per-phase cooldown.
  if (marker.lastNudgeAt && sinceLastNudge < stallHit.reNudgeMin) return;
  // Re-emit on reNudgeMin cadence so alert count grows to DEAD_END_REEMITS
  // (marker resets on phase change, so re-emits stop naturally on advance).
  const escalation = escalationFor(ctx.phase, marker.nudges);
  const reason = `phase=${ctx.phase} stuck ${stallHit.elapsedMin}m budget=${stallHit.budgetMin}m nudge ${marker.nudges + 1}/${stallHit.maxNudges}`;

  if (escalation === 'alert') {
    const paneTail = (ctx.pane || '').split('\n').slice(-40).join('\n');
    const unblockCmd = `tmux capture-pane -t ${ctx.session} -p | tail -40   # read pane, then either tmux send-keys to unstick or kill via plugins/maestro/scripts/maestro-cleanup.js ${ctx.ticket} --tmux`;
    const r = actions.alert({
      session: ctx.session,
      ticket: ctx.ticket,
      kind: 'nudges-exhausted',
      phase: ctx.phase,
      elapsedMin: stallHit.elapsedMin,
      budgetMin: stallHit.budgetMin,
      nudges: marker.nudges,
      paneTail,
      unblockCmd,
      instruction: `OPERATOR ACTION REQUIRED — agent stalled in phase=${ctx.phase} for ${stallHit.elapsedMin}m/${stallHit.budgetMin}m (${marker.nudges} nudges ignored). RUN NOW: ${unblockCmd}. UNBLOCK-PROTOCOL: bad artifact (tasks.md/brief.md) usually root cause, NOT missing work. Pane tail in paneTail field. DO NOT reply with "standing by" — that is a no-op while the agent burns dead-end attempts.`,
    });
    maybeEscalateToDeadEnd(ctx, 'nudges-exhausted', r.count, ctx.phase);
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
    // Helper (-dev / -listen) idle past SILENCE_LIMIT_SEC — don't kill. Refresh
    // marker so silence timer restarts (else fires every tick → log spam).
    // Helper sessions (-listen / -dev) are inert by design; their idleness
    // carries zero information for the operator. Refresh the marker so the
    // detector doesn't re-fire each tick, but emit nothing.
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
    return true;
  }
  // autoRestart skipped (wedged quiet window, ci-gate-freed, dead-end, or
  // missing worktree) — pane is still alive and listed, so let downstream
  // detectors (notably prStatus) keep emitting pr-ready/pr-broken transitions.
  return false;
}

function runPhaseStallDetector(ctx) {
  // -listen/-dev helpers inherit ticket phase but have no agent to make progress;
  // running phase-stall on them accumulates nudges that never resolve → cascade kill.
  if (!restartEligible(ctx.session)) return;
  const pHit = DETECTORS.phaseStall.detect(ctx);
  if (pHit.hit) handlePhaseStall(ctx, pHit);
}

function runCommitStallDetector(ctx) {
  // Helpers can't commit; only -work meaningfully stalls on commits.
  if (!restartEligible(ctx.session)) return;
  // detector handles its own dedup + marker — only "hits" on threshold crossings.
  const cHit = DETECTORS.commitStall.detect(ctx);
  if (!cHit.hit) return;
  alerts.log(
    `${ctx.session} commit-stall ${cHit.mins}m in phase=${ctx.phase} (threshold=${cHit.threshold}m)`
  );
}

function runPrCommentsDetector(ctx) {
  if (!restartEligible(ctx.session)) return;
  const cHit = DETECTORS.prComments.detect(ctx);
  if (cHit.hit) {
    handlePrComments(ctx, cHit);
    return;
  }
  // Detector reset its marker (comments gone, HEAD moved, or count changed) →
  // also purge the persisted pr-comments-stuck alert count so a fresh stuck
  // cycle starts at 1 instead of inheriting a near-dead-end repeat count.
  if (cHit.reset) {
    alerts.resetCount(
      alerts.alertKey({ session: ctx.session, kind: 'pr-comments-stuck', phase: ctx.phase })
    );
  }
}

function runPrStatusDetector(ctx) {
  if (!restartEligible(ctx.session)) return;
  const sHit = DETECTORS.prStatus.detect(ctx);
  if (!sHit.hit) return;
  // pr-pending is informational only — log but never escalate to alert sink.
  if (sHit.kind === 'pr-pending') {
    alerts.log(
      `${ctx.session} pr-pending PR #${sHit.prNumber} sha=${(sHit.sha || '').slice(0, 7)} checks running`
    );
    return;
  }
  // pr-ready / pr-broken → structured alert sink. Target -work explicitly
  // (pr-status dedups per-ticket so -listen could otherwise own the alert).
  const workSession = `${ctx.ticket}-work`;
  actions.alert(prStatusPayload.buildPayload({ ctx, sHit, workSession, tmux }));
  ciGate.maybeFreeOnPrReady({ ctx, sHit, workSession, actions });
}

/** Reset dead-end attempts when the ticket's phase has advanced since last tick.
 * Real progress (phase forward-step) signals the agent is unstuck, so the
 * next dead-end should be treated as attempt 1 again, not as continued
 * escalation from earlier stalls in unrelated phases.
 */
const manifestMod = require('./lib/maestro-conduct/manifest');
function detectPhaseAdvance(ctx) {
  if (!restartEligible(ctx.session)) return;
  const prev = state.read(ctx.ticket, 'last-phase') || {};
  if (prev.phase && prev.phase !== ctx.phase) {
    const reset = manifestMod.resetTaskAttempts(ctx.ticket);
    if (reset) {
      alerts.log(
        `${ctx.session} phase advance ${prev.phase} → ${ctx.phase} — dead-end attempts reset`
      );
    }
    try {
      state.clear(ctx.ticket, 'dead-end');
    } catch {}
  }
  if (prev.phase !== ctx.phase) {
    state.write(ctx.ticket, 'last-phase', { phase: ctx.phase, seenAt: state.now() });
  }
}

/** Run the per-session pipeline. Returns when the session has been fully processed. */
function tickSession(session) {
  const ctx = ctxFor(session);

  // Phase-advance check: clear stale dead-end markers + attempts the moment
  // the agent makes real progress. Runs before detectors so a freshly-
  // advanced ticket isn't treated as still-stalled this tick.
  detectPhaseAdvance(ctx);

  // Question always wins — never nudge while the agent is waiting on us.
  const qHit = DETECTORS.question.detect(ctx);
  if (qHit.hit) {
    handleQuestion(ctx, qHit);
    return;
  }
  state.clear(ctx.session, 'question');
  // Reset persisted question-pending count so a later prompt in the same
  // phase doesn't inherit [REPEAT N] and fire freeDeadEndSlot prematurely.
  alerts.resetCount(
    alerts.alertKey({ session: ctx.session, kind: 'question-pending', phase: ctx.phase })
  );

  // LOCAL OVERRIDE: agents at ci/complete are doing zero useful work — kill
  // them immediately to free the slot, regardless of silence/spinner state.
  // Runs before silence so we don't waste a tick auto-restarting them first.
  if (ciGate.maybeRotateOnPhase({ ctx, state, actions, restartEligible })) return;

  const detectorsToRun = phaseFor(ctx.phase).detectors.filter((k) => k !== 'question');

  // Silence runs before spinner: a totally-dead pane is more urgent than a
  // hung spinner, and the restart wipes spinner state anyway.
  if (detectorsToRun.includes('silence') && runSilenceDetector(ctx)) return;
  if (detectorsToRun.includes('spinner') && runSpinnerDetector(ctx)) return;
  if (detectorsToRun.includes('phaseStall')) runPhaseStallDetector(ctx);
  if (detectorsToRun.includes('commitStall')) runCommitStallDetector(ctx);
  if (detectorsToRun.includes('prComments')) runPrCommentsDetector(ctx);
  if (detectorsToRun.includes('prStatus')) runPrStatusDetector(ctx);
  // Phase-based rotation runs after all detectors so it sees the freshest
  // marker state, and catches the steady-state pr-ready case independent of
  // pr-status detector dedup.
  ciGate.maybeRotateOnPhase({ ctx, state, actions, restartEligible });
}

function maybeEmitHeartbeat(sessions) {
  const now = state.now();
  const body = heartbeat.buildHeartbeat(sessions);
  const sinceLast = lastHeartbeatAt ? now - lastHeartbeatAt : Infinity;
  const bodyChanged = body !== lastHeartbeatBody;
  const stale = sinceLast >= HEARTBEAT_MAX_MIN * 60;

  // Body changed → emit immediately (state-change-driven contract; review
  // feedback fixed: the floor used to suppress these for the first 15m).
  // Body unchanged → respect HEARTBEAT_MIN as a floor and emit only when
  // we've also hit HEARTBEAT_MAX_MIN (daemon-alive signal).
  if (bodyChanged) {
    // emit
  } else if (stale && sinceLast >= HEARTBEAT_MIN * 60) {
    // emit
  } else {
    return;
  }

  lastHeartbeatAt = now;
  lastHeartbeatBody = body;
  alerts.log(body);
}

function tick() {
  const sessions = tmux.listSessions();
  // Reconcile manifest task statuses against live tmux at the top of each tick.
  // Cheap (≤ N file reads, only writes on drift) and gives the operator a live
  // view of pool occupancy without polling tmux.
  try {
    actions.syncManifest(sessions);
  } catch (e) {
    alerts.log(`syncManifest failed: ${e.message}`);
  }
  // Top-up the pool when sessions exit outside the slot-freed path (operator
  // kill, agent crash, manifest re-added). Gated by AUTO_BOOTSTRAP_NEXT=1.
  try {
    actions.maybeFillPool();
  } catch (e) {
    alerts.log(`maybeFillPool failed: ${e.message}`);
  }
  if (!sessions.length) {
    alerts.log('no GH-*-work sessions');
    return;
  }
  for (const session of sessions) tickSession(session);
  maybeEmitHeartbeat(sessions);
}

function handlePrComments(ctx, cHit) {
  prCommentsHandler.handlePrComments({
    ctx,
    cHit,
    state,
    actions,
    phaseFor,
    escalationFor,
    bumpMarker,
    maybeEscalateToDeadEnd,
  });
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
// DETECTORS is exported so the cross-plugin dispatch-registry validator (in
// `factories/dispatchRegistryValidator`) can assert that every detector name
// referenced in phase-registry.PHASES[*].detectors resolves to a real module.
module.exports = { tick, ctxFor, restartEligible, DETECTORS };
