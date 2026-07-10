#!/usr/bin/env node
/**
 * maestro-conduct.js — the maestro's active conducting loop.
 *
 * The conductor keeps each player on tempo. For every GH-*-work tmux session:
 *   1. Determine current phase via the skill-registry row for the ticket's
 *      persisted skill (never raw .work-state.json — a stale one applied
 *      /work phase coaching to foreign workflows)
 *   2. Look up the detectors registered for this phase (phase-registry.js)
 *   3. Question detection always runs first — if the agent is waiting on
 *      a decision, never nudge it; track pending time and escalate to a
 *      maestro alert if it sits unanswered.
 *   4. Every activity heuristic (spinner, silence, phase budget) is gated on
 *      the worktree-progress signal — a changing worktree means the agent is
 *      WORKING, however the pane looks (detector-runners.js).
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
const skillRegistry = require('./lib/maestro-conduct/skill-registry');

const ciGate = require('./lib/maestro-conduct/ci-gate-rotation');
const manifest = require('./lib/maestro-conduct/manifest');
const runtimeProfile = require('./lib/maestro-conduct/runtime-profile');
const stopCondition = require('./lib/maestro-conduct/stop-condition');
const prStatusPayload = require('./lib/maestro-conduct/pr-status-payload');
const prCommentsHandler = require('./lib/maestro-conduct/pr-comments-handler');
const questionHandler = require('./lib/maestro-conduct/question-handler');
const singletonGuard = require('./lib/maestro-conduct/singleton-guard');
const fleetEmpty = require('./lib/maestro-conduct/fleet-empty');
const commitStallRunner = require('./lib/maestro-conduct/commit-stall-runner');
const progress = require('./lib/maestro-conduct/progress');
const runners = require('./lib/maestro-conduct/detector-runners');
const { detectPhaseAdvance } = require('./lib/maestro-conduct/phase-advance');
const activeMarker = require('./lib/maestro-conduct/active-marker');

const DETECTORS = {
  question: require('./lib/maestro-conduct/detectors/question'),
  silence: require('./lib/maestro-conduct/detectors/silence'),
  spinner: require('./lib/maestro-conduct/detectors/spinner'),
  phaseStall: require('./lib/maestro-conduct/detectors/phase-stall'),
  commitStall: require('./lib/maestro-conduct/detectors/commit-stall'),
  prComments: require('./lib/maestro-conduct/detectors/pr-comments'),
  prStatus: require('./lib/maestro-conduct/detectors/pr-status'),
  stuckInput: require('./lib/maestro-conduct/detectors/stuck-input'),
};

// Re-emit escalation: when the same (session, kind, sha/phase) alert fires
// this many times, auto-rotate the slot via freeDeadEndSlot.
const DEAD_END_REEMITS = parseInt(process.env.DEAD_END_REEMITS || '3', 10);

function maybeEscalateToDeadEnd(ctx, kind, repeatCount, sha) {
  if (repeatCount < DEAD_END_REEMITS || ['wait_merge', 'ci', 'complete'].includes(ctx.phase))
    return;
  // WP-09: operator-attached codex TUI panes are read-only to the conductor
  // (no dialect regexes yet) — DEAD-END-HOLD is the default: alert-only,
  // never auto-kill on pane evidence we cannot actually read.
  if (ctx.dialect === 'codex-tui-conservative') {
    alerts.log(
      `${ctx.session} DEAD-END-HOLD ${kind} ×${repeatCount} — codex TUI dialect is read-only; operator must intervene (no auto-kill)`,
      { kind: 'log-only' } // the triggering alert (question-pending/…) already carries the throttled wake
    );
    return;
  }
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

// ctxFor: build the context object passed to every detector.
// GH-514 R2/AC3: skill is read per-call via skill-registry so /follow-up etc.
// are honored and daemon restarts pick up mid-session skill writes. A
// regex-valid non-whitelisted skill (qc-work, …) resolves to the GENERIC row
// — it must never fall through to the work row, which would read a stale
// .work-state.json and apply /work phase coaching to a foreign workflow.
// command/commandBrief come from the owning manifest so alert payloads can
// tell the operator WHAT the agent is running (and what "done" means).
function ctxFor(session) {
  const ticket = tmux.ticketIdFor(session);
  const skill = skillRegistry.readTicketSkill(ticket);
  const row = skillRegistry.get(skill) || skillRegistry.get('work');
  const snap = row.snapshot(ticket) || { phase: null, step: null };
  const { phase, step } = snap;
  const worktree = path.join(workstate.WORKTREES_BASE, `${REPO_NAME}-${ticket}`);
  const pane = tmux.capture(session);
  const launch = manifest.launchConfigForTask(ticket);
  // WP-09: per-ticket runtime (mixed fleets) + the pane dialect gating every
  // claude-TUI heuristic. runtime='claude' resolves for every pre-WP-09 fleet
  // (no .maestro-runtime file, no manifest runtime, no env) so those ctx
  // objects only GAIN fields — detector behavior is byte-identical.
  const runtime = runtimeProfile.runtimeForTicket(ticket);
  return {
    session,
    ticket,
    skill,
    phase,
    step,
    worktree,
    pane,
    command: launch.command,
    commandBrief: launch.commandBrief,
    runtime,
    dialect: runtimeProfile.paneDialect(ticket, runtime),
    execLog: runtimeProfile.execLogPath(ticket),
  };
}

// One-shot conductor notice per codex session (C14): the operator must know
// question/spinner detection is off and which signals replace it.
function noteCodexConducting(ctx) {
  if (ctx.runtime !== 'codex' || state.read(ctx.session, 'codex-notice')) return;
  state.write(ctx.session, 'codex-notice', { loggedAt: state.now(), dialect: ctx.dialect });
  alerts.log(
    `${ctx.ticket} (codex): question/spinner detection unavailable — using exec-json/workstate signals (dialect=${ctx.dialect})`,
    { kind: 'log-only' }
  );
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

function runPhaseStallDetector(ctx) {
  // -listen/-dev helpers inherit ticket phase but have no agent to make progress;
  // running phase-stall on them accumulates nudges that never resolve → cascade kill.
  if (!restartEligible(ctx.session)) return;
  const pHit = DETECTORS.phaseStall.detect(ctx);
  if (pHit.hit) runners.handlePhaseStall(ctx, pHit, { maybeEscalateToDeadEnd });
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
      `${ctx.session} pr-pending PR #${sHit.prNumber} sha=${(sHit.sha || '').slice(0, 7)} checks running`,
      { kind: 'log-only' }
    );
    return;
  }
  // pr-ready / pr-broken → structured alert sink. Target -work explicitly
  // (pr-status dedups per-ticket so -listen could otherwise own the alert).
  const workSession = tmux.sessionName(ctx.ticket, 'work');
  actions.alert(prStatusPayload.buildPayload({ ctx, sHit, workSession, tmux }));
  ciGate.maybeFreeOnPrReady({ ctx, sHit, workSession, actions });
}

// Run the phase's detector set in priority order. Silence/spinner short-circuit
// the tick (return true) when they fire a restart/interrupt; the remaining
// detectors are advisory and always run.
function runPhaseDetectors(ctx) {
  const detectorsToRun = phaseFor(ctx.phase).detectors.filter((k) => k !== 'question');

  // Silence runs before spinner: a totally-dead pane is more urgent than a
  // hung spinner, and the restart wipes spinner state anyway.
  if (detectorsToRun.includes('silence') && runners.runSilenceDetector(ctx, { restartEligible }))
    return;
  if (detectorsToRun.includes('spinner') && runners.runSpinnerDetector(ctx)) return;
  if (detectorsToRun.includes('phaseStall')) runPhaseStallDetector(ctx);
  if (detectorsToRun.includes('commitStall'))
    commitStallRunner.runCommitStallDetector(ctx, { restartEligible });
  if (detectorsToRun.includes('prComments')) runPrCommentsDetector(ctx);
  if (detectorsToRun.includes('prStatus')) runPrStatusDetector(ctx);
  // Phase-based rotation runs after all detectors so it sees the freshest
  // marker state, and catches the steady-state pr-ready case independent of
  // pr-status detector dedup.
  ciGate.maybeRotateOnPhase({ ctx, state, actions, restartEligible });
}

/** Run the per-session pipeline. Returns when the session has been fully processed. */
function tickSession(session) {
  const ctx = ctxFor(session);
  noteCodexConducting(ctx);
  // One progress observation per session per tick; detectors read the marker.
  const prog = progress.observe(ctx.ticket, ctx.worktree);
  // Real progress (phase forward-step) resets the dead-end strike counter so
  // an old stall in an unrelated phase can't escalate a fresh one (PR #603).
  detectPhaseAdvance(ctx, restartEligible);

  // Question always wins — never nudge while the agent is waiting on us.
  const qHit = DETECTORS.question.detect(ctx);
  if (qHit.hit) {
    state.clear(ctx.session, 'question-absent'); // re-arm the reset debounce
    handleQuestion(ctx, qHit);
    return;
  }
  state.clear(ctx.session, 'question');
  // Reset persisted question-pending count so a later prompt in the same
  // phase doesn't inherit [REPEAT N] and fire freeDeadEndSlot prematurely.
  // Debounced to 3 consecutive question-free ticks (GH-680 review): resetting
  // on the FIRST miss let a flapping prompt (pane redraws across ticks) clear
  // the re-wake throttle every cycle and wake per flap.
  const absent = (state.read(ctx.session, 'question-absent') || { ticks: 0 }).ticks + 1;
  if (absent >= 3) {
    // resolve() supersedes the old exact-key resetCount: it purges counts +
    // throttle across ALL phase variants of the key and appends an
    // alert-resolved record so the banner drops the answered prompt (GH-698).
    // No-op when nothing was pending, so calling it every tick is free.
    alerts.resolve(ctx.session, 'question-pending', 'prompt no longer visible');
  }
  state.write(ctx.session, 'question-absent', { ticks: absent });

  runners.runStuckInputDetector(ctx, { restartEligible });
  runners.runAuthBrokenDetector(ctx, { restartEligible });

  // Stop-condition runs before the detectors: a ticket whose oracle reports
  // done must be reaped (kill + rotate to the next queued ticket) BEFORE the
  // silence detector tries to auto-restart the now-idle agent. No-op for
  // tickets without a compiled oracle.
  if (stopCondition.maybeStopOnOracle({ ctx, actions, manifest, restartEligible })) return;

  runPhaseDetectors(ctx);
  runners.runNoProgressCheck(ctx, prog, { restartEligible });
}

function tick() {
  const sessions = tmux.listSessions();
  // Refresh the status-bar marker from the live session list (self-heals as the
  // fleet comes up; derives its prefix, no TICKET_PREFIX env dependency).
  try {
    activeMarker.writeActiveMarker(sessions);
  } catch (e) {
    alerts.log(`writeActiveMarker failed: ${e.message}`);
  }
  // Reconcile manifest task statuses against live tmux at the top of each tick.
  // Cheap (≤ N file reads, only writes on drift) and gives the operator a live
  // view of pool occupancy without polling tmux.
  try {
    actions.syncManifest(sessions);
  } catch (e) {
    alerts.logFault(`syncManifest failed: ${e.message}`, 'sync-manifest');
  }
  // Top-up the pool when sessions exit outside the slot-freed path (operator
  // kill, agent crash, manifest re-added). Gated by AUTO_BOOTSTRAP_NEXT=1.
  try {
    actions.maybeFillPool();
  } catch (e) {
    alerts.logFault(`maybeFillPool failed: ${e.message}`, 'fill-pool');
  }
  fleetEmpty.checkFleetEmpty(sessions, restartEligible);
  if (!sessions.length) {
    // log-only: pre-680 this line woke the conductor EVERY 60s tick on an
    // empty fleet — the single worst idle-burn source.
    alerts.log(`no ${tmux.sessionName(`${tmux.resolveTicketPrefix()}-*`, 'work')} sessions`, {
      kind: 'log-only',
    });
    return;
  }
  // Per-session isolation: one throwing detector must not abort the tick for
  // every other session — and in daemon mode an escaped exception killed the
  // whole process SILENTLY (setInterval → uncaughtException → exit with no
  // log line), leaving the fleet unwatched until someone noticed. Observed as
  // unexplained daemon restarts with dead windows between them.
  for (const session of sessions) {
    try {
      tickSession(session);
    } catch (e) {
      // First occurrence wakes; a persistently-throwing detector backs off
      // instead of billing a wake every 60s tick (GH-680 review).
      alerts.logFault(`TICK-ERROR ${session}: ${(e && e.stack) || e}`, `tick-error|${session}`);
    }
  }
  heartbeat.maybeEmitHeartbeat(sessions);
}

function handlePrComments(ctx, cHit) {
  prCommentsHandler.handlePrComments({
    ctx,
    cHit,
    state,
    actions,
    phaseFor,
    escalationFor,
    bumpMarker: runners.bumpMarker,
    maybeEscalateToDeadEnd,
  });
}

// GH-622: a long-running conductor claims a per-namespace lock (singleton-guard)
// so a second daemon in the SAME namespace is detected instead of both driving
// (and racing on) the same agents. One-shot ticks don't lock — the conflict is
// specific to two persistent daemons.
// Status-bar active-marker writer lives in ./lib/maestro-conduct/active-marker
// (derives the fleet prefix from live sessions; written every tick).

// Last-resort visibility: any error that escapes the per-session guards must
// land in the log file, not vanish on a detached stderr. The daemon keeps
// ticking on uncaughtException — each tick is self-contained, and a running
// (slightly bruised) conductor beats an unwatched fleet.
function installCrashHandlers() {
  process.on('uncaughtException', (e) => {
    alerts.log(`DAEMON-CRASH uncaughtException: ${(e && e.stack) || e}`);
  });
  process.on('unhandledRejection', (r) => {
    alerts.log(`DAEMON-CRASH unhandledRejection: ${(r && r.stack) || r}`);
  });
  process.on('exit', (code) => {
    alerts.log(`daemon exiting code=${code} pid=${process.pid}`);
  });
}

function main() {
  const daemon = process.argv.includes('--daemon');
  if (!daemon) {
    tick();
    return;
  }
  const nsLabel = singletonGuard.acquireOrExit();
  installCrashHandlers();
  alerts.log(`orchestrate daemon starting, tick=${TICK_SEC}s namespace="${nsLabel}"`);
  const guardedTick = () => {
    // MAESTRO_FORCE=1 lets a new conductor STEAL the lock without killing the
    // incumbent — which then kept ticking, double-driving every agent (two
    // daemons were observed Esc-interrupting the same panes). Yield the loop
    // the moment the lock is no longer ours.
    if (!singletonGuard.stillOwner()) {
      alerts.log(
        `CONDUCTOR-USURPED namespace="${nsLabel}" — lock taken over by another conductor; this daemon (pid ${process.pid}) exits`
      );
      process.exit(4);
    }
    tick();
  };
  setInterval(guardedTick, TICK_SEC * 1000);
  guardedTick();
}

if (require.main === module) main();
// DETECTORS is exported so the cross-plugin dispatch-registry validator (in
// `factories/dispatchRegistryValidator`) can assert that every detector name
// referenced in phase-registry.PHASES[*].detectors resolves to a real module.
// maybeEscalateToDeadEnd is exported so the WP-09 DEAD-END-HOLD acceptance
// test can prove a codex TUI session is never rotated on glyph evidence.
module.exports = { tick, ctxFor, restartEligible, DETECTORS, maybeEscalateToDeadEnd };
