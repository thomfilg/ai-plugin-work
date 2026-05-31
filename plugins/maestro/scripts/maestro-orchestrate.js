#!/usr/bin/env node
/**
 * maestro-orchestrate.js — the maestro's active conducting loop.
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
const tmux = require('./lib/maestro-orchestrate/tmux');
const state = require('./lib/maestro-orchestrate/state');
const workstate = require('./lib/maestro-orchestrate/workstate');
const { phaseFor, escalationFor } = require('./lib/maestro-orchestrate/phase-registry');
const actions = require('./lib/maestro-orchestrate/actions');
const alerts = require('./lib/maestro-orchestrate/alerts');

const DETECTORS = {
  question:    require('./lib/maestro-orchestrate/detectors/question'),
  spinner:     require('./lib/maestro-orchestrate/detectors/spinner'),
  phaseStall:  require('./lib/maestro-orchestrate/detectors/phase-stall'),
  commitStall: require('./lib/maestro-orchestrate/detectors/commit-stall'),
  prComments:  require('./lib/maestro-orchestrate/detectors/pr-comments'),
};

const REPO_NAME = process.env.REPO_NAME || 'claude-plugin-work';
const Q_WAIT_MIN = parseInt(process.env.Q_WAIT_MIN || '3', 10);
const TICK_SEC = parseInt(process.env.TICK_SEC || '60', 10);

/** Build the context object passed to every detector. */
function ctxFor(session) {
  const ticket = session.replace(/-work$/, '');
  const phase = workstate.currentPhase(ticket);
  const step = workstate.currentStep(ticket);
  const worktree = path.join(workstate.WORKTREES_BASE, `${REPO_NAME}-${ticket}`);
  const pane = tmux.capture(session);
  return { session, ticket, phase, step, worktree, pane };
}

function handleQuestion(ctx, qHit) {
  const prev = state.read(ctx.ticket, 'question');
  const now = state.now();
  if (!prev) {
    state.write(ctx.ticket, 'question', { startedAt: now, alerted: false });
    return;
  }
  const mins = state.minutesSince(prev.startedAt);
  if (mins >= Q_WAIT_MIN && !prev.alerted) {
    actions.alert({
      session: ctx.session, ticket: ctx.ticket,
      kind: 'question-pending', phase: ctx.phase,
      elapsedMin: mins, options: qHit.options, promptKind: qHit.promptKind,
    });
    state.write(ctx.ticket, 'question', { startedAt: prev.startedAt, alerted: true });
  }
}

// Healthy "waiting on user" patterns the agent emits to the pane while halted.
// When detected, phase-stall is suppressed — the agent is not stuck.
const HALTED_WAITING_PATTERNS = [
  /awaiting.*merge|wait.*merge|Once you( click| have)? merge/i,
  /Per.*never-auto-merge|won['']t merge|won['']t auto-merge/i,
  /CI is green.*[Mm]erge when ready/i,
];

function isHaltedWaitingForUser(pane) {
  if (!pane) return false;
  return HALTED_WAITING_PATTERNS.some(re => re.test(pane));
}

function handlePhaseStall(ctx, stallHit) {
  const profile = phaseFor(ctx.phase);
  if (profile.exempts(ctx)) {
    alerts.log(`${ctx.session} phase-stall exempted by registry for phase=${ctx.phase}`);
    return;
  }
  // Suppress when the agent is correctly waiting for a human action (merge, etc.)
  if (isHaltedWaitingForUser(ctx.pane)) {
    alerts.log(`${ctx.session} phase-stall suppressed — agent halted waiting for user (phase=${ctx.phase})`);
    return;
  }
  const marker = stallHit.marker;
  const sinceLastNudge = marker.lastNudgeAt ? state.minutesSince(marker.lastNudgeAt) : Infinity;
  // Don't re-nudge before the per-phase cooldown.
  if (marker.lastNudgeAt && sinceLastNudge < stallHit.reNudgeMin) return;
  // Once nudges are exhausted, stop re-alerting until the phase actually advances.
  // (The marker is reset on phase change inside the phase-stall detector.)
  if (marker.nudges >= stallHit.maxNudges) return;

  const escalation = escalationFor(ctx.phase, marker.nudges);
  const reason = `phase=${ctx.phase} stuck ${stallHit.elapsedMin}m budget=${stallHit.budgetMin}m nudge ${marker.nudges + 1}/${stallHit.maxNudges}`;

  if (escalation === 'alert') {
    actions.alert({
      session: ctx.session, ticket: ctx.ticket,
      kind: 'nudges-exhausted', phase: ctx.phase,
      elapsedMin: stallHit.elapsedMin, budgetMin: stallHit.budgetMin,
      nudges: marker.nudges,
    });
  } else if (escalation === 'interrupt') {
    actions.interrupt(ctx.session, reason);
  } else {
    actions.soft(ctx.session, reason);
  }
  state.write(ctx.ticket, 'phase', { ...marker, nudges: marker.nudges + 1, lastNudgeAt: state.now() });
}

function tick() {
  const sessions = tmux.listSessions();
  if (!sessions.length) { alerts.log('no GH-*-work sessions'); return; }

  for (const session of sessions) {
    const ctx = ctxFor(session);

    // Question always wins — never nudge while the agent is waiting on us.
    const qHit = DETECTORS.question.detect(ctx);
    if (qHit.hit) { handleQuestion(ctx, qHit); continue; }
    state.clear(ctx.ticket, 'question');

    const detectorsToRun = phaseFor(ctx.phase).detectors.filter(k => k !== 'question');

    // Spinner hang is an immediate interrupt; doesn't go through nudge counter.
    if (detectorsToRun.includes('spinner')) {
      const sHit = DETECTORS.spinner.detect(ctx);
      if (sHit.hit) {
        actions.interrupt(ctx.session, `spinner stuck ${sHit.elapsedMin}m: ${sHit.line}`);
        continue;
      }
    }

    // Phase stall drives the soft → interrupt → alert chain.
    if (detectorsToRun.includes('phaseStall')) {
      const pHit = DETECTORS.phaseStall.detect(ctx);
      if (pHit.hit) handlePhaseStall(ctx, pHit);
    }

    // Commit stall is informational — surfaces in the log only.
    if (detectorsToRun.includes('commitStall')) {
      const cHit = DETECTORS.commitStall.detect(ctx);
      if (cHit.hit) alerts.log(`${ctx.session} commit-stall ${cHit.mins}m in phase=${ctx.phase}`);
    }

    // Unaddressed PR comments — only on follow_up. Same escalation chain as phase stall.
    if (detectorsToRun.includes('prComments')) {
      const cHit = DETECTORS.prComments.detect(ctx);
      if (cHit.hit) handlePrComments(ctx, cHit);
    }
  }
}

function handlePrComments(ctx, cHit) {
  const marker = cHit.marker;
  const sinceLastNudge = marker.lastNudgeAt ? state.minutesSince(marker.lastNudgeAt) : Infinity;
  const profile = phaseFor(ctx.phase);
  // Use the same per-phase re-nudge cooldown so we don't spam.
  if (marker.lastNudgeAt && sinceLastNudge < profile.reNudgeMin) return;

  const nudges = marker.nudges || 0;
  const top = cHit.summary.map(s => `${s.file}:${s.line} [${s.severity||'?'}] ${s.title}`).join(' | ');
  const reason = `PR #${cHit.prNumber} has ${cHit.count} unaddressed bot comment(s), HEAD unchanged ${cHit.minsStuck}m. Top: ${top}`;
  const escalation = escalationFor(ctx.phase, nudges);

  if (escalation === 'alert') {
    actions.alert({
      session: ctx.session, ticket: ctx.ticket,
      kind: 'pr-comments-stuck', phase: ctx.phase,
      prNumber: cHit.prNumber, count: cHit.count,
      elapsedMin: cHit.minsStuck, summary: cHit.summary,
    });
  } else if (escalation === 'interrupt') {
    actions.interrupt(ctx.session, reason);
  } else {
    actions.soft(ctx.session, reason);
  }
  state.write(ctx.ticket, 'pr-comments', { ...marker, nudges: nudges + 1, lastNudgeAt: state.now() });
}

function main() {
  const daemon = process.argv.includes('--daemon');
  if (!daemon) { tick(); return; }
  alerts.log(`orchestrate daemon starting, tick=${TICK_SEC}s`);
  setInterval(tick, TICK_SEC * 1000);
  tick();
}

if (require.main === module) main();
module.exports = { tick, ctxFor };
