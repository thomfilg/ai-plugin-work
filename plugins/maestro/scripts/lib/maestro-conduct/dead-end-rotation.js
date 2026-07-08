/**
 * dead-end-rotation.js — the attempt-based dead-end recovery path, extracted
 * from actions.js to keep that file under the max-lines gate (mirrors the
 * slot-rotation.js extraction). Ported from PR #603 and merged with the
 * question-hold guard from the hardening pass.
 *
 * The function that depends on actions.js internals (killAndBootstrapNext, the
 * thin wrapper that injects maybeAutoBootstrap + alert) is received as a
 * parameter so there is no circular require back into actions.js.
 */
const { spawnSync } = require('child_process');
const alerts = require('./alerts');
const state = require('./state');
const manifest = require('./manifest');
const progress = require('./progress');
const { findNextEligibleTask } = require('./next-task');

const DEAD_END_MAX_ATTEMPTS = parseInt(process.env.DEAD_END_MAX_ATTEMPTS || '3', 10);

// Grace window (minutes) after the attempt-1 diagnostic probe during which a
// re-emit must NOT bump attempts or kill — gives the agent time to answer the
// probe before the slot rotates. maybeEscalateToDeadEnd can re-call
// freeDeadEndSlot on consecutive ticks (question re-emit / nudges-exhausted
// re-emit); without this the second tick would immediately reach attempt 2 and
// kill, so the probe's "wait for the reply" promise never held.
const DEAD_END_PROBE_GRACE_MIN = parseInt(process.env.DEAD_END_PROBE_GRACE_MIN || '3', 10);

/**
 * Pre-rotation guards that hold the session alive instead of probing/killing:
 *   - fresh worktree progress: a producing agent is never a dead end,
 *     regardless of how many alerts re-fired (GH-627: gate dead-ends on
 *     progress, not patience);
 *   - question-pending with no queued work: the agent is blocked on input,
 *     burning nothing — killing gains no slot and destroys context.
 * Returns true when the rotation must be skipped this tick.
 */
function holdInsteadOfRotate({ session, ticket, kind, repeatCount }) {
  if (progress.hasFreshProgress(ticket)) {
    alerts.log(
      `${session} DEAD-END-HOLD ${kind} ×${repeatCount} — worktree changed <${progress.PROGRESS_FRESH_MIN}m ago; a progressing agent is not a dead end`,
      { kind: 'log-only' } // no-action hold; fires per re-emit tick
    );
    return true;
  }
  if (kind !== 'question-pending' || findNextEligibleTask(ticket)) return false;
  const hold = state.read(ticket, 'dead-end-hold') || {};
  if (!hold.loggedAt || state.minutesSince(hold.loggedAt) >= 30) {
    alerts.log(
      `${session} DEAD-END-HOLD question-pending ×${repeatCount} — no eligible next task, keeping session alive; operator must answer the prompt`,
      { kind: 'log-only' } // the question-pending alerts themselves keep waking
    );
    state.write(ticket, 'dead-end-hold', { loggedAt: state.now() });
  }
  return true;
}

/**
 * freeDeadEndSlot — agent is stuck (operator didn't respond; every menu option
 * a bypass; PR has no forward path). Triggered by re-emit escalation when the
 * same alert kind fires ≥ DEAD_END_REEMITS times.
 *
 * TWO decoupled counters drive recovery:
 *
 *   1. Probe-vs-kill tier = the PER-LIFECYCLE `dead-end` state marker (NOT
 *      manifest.attempts). The first dead-end of a lifecycle (`!marker.diagnosed`)
 *      sends the diagnostic probe — a probe is NOT a strike, so attempts is left
 *      untouched. A later re-emit (after the grace window) is the kill: it bumps
 *      manifest.attempts once and rotates. Because bootstrap clears this marker,
 *      every re-bootstrapped lifecycle gets a fresh probe before any kill.
 *
 *   2. Blocked tier = manifest.attempts, accumulating ACROSS lifecycles. Bumped
 *      once per lifecycle (only on the kill path). When attempts reach
 *      DEAD_END_MAX_ATTEMPTS the ticket goes `blocked`; below that, `pending`
 *      (re-eligible). attempts is reset ONLY on real progress (phase advance),
 *      never on re-bootstrap — so repeated dead-ends genuinely march toward
 *      `blocked`.
 *
 * killAndBootstrapNext + alert are injected by the caller (actions.js) to avoid
 * a circular require.
 */
function freeDeadEndSlot({ session, ticket, kind, repeatCount, sha, killAndBootstrapNext, alert }) {
  if (process.env.AUTO_FREE_DEAD_END === '0') return false;
  const marker = state.read(ticket, 'dead-end') || {};
  if (marker.killed) return false; // already freed this lifecycle

  if (holdInsteadOfRotate({ session, ticket, kind, repeatCount })) return false;

  // Grace guard: the probe was already sent and we're still inside the grace
  // window — no-op WITHOUT bumping attempts or killing so the agent can answer
  // the probe first. diagnosedAt and state.now() are both unix seconds.
  if (marker.diagnosed && state.now() - (marker.diagnosedAt || 0) < DEAD_END_PROBE_GRACE_MIN * 60) {
    return false;
  }

  // Untracked guard: a session with no manifest entry has no pool slot to
  // attempt-account for, so dead-end rotation does not apply — bail WITHOUT
  // probing or killing. getTaskAttempts returns null only when the ticket is
  // registered in no manifest (0 is a tracked, zero-strike ticket).
  const attempts = manifest.getTaskAttempts(ticket);
  if (attempts === null) {
    alerts.log(
      `${session} DEAD-END skipped — ticket ${ticket} not in any manifest; no attempt accounting, no rotation`,
      { kind: 'log-only' }
    );
    return false;
  }

  // First dead-end of THIS lifecycle: don't kill — ask the agent to diagnose
  // itself first so the operator can read what's blocking before rotating. A
  // probe is not a strike, so attempts stays put.
  if (!marker.diagnosed) {
    sendDeadEndProbe({ session, ticket, kind, repeatCount, sha, attempts, alert });
    return true;
  }

  // marker.diagnosed AND grace elapsed → this is the kill. Bump attempts exactly
  // once (the strike) then rotate.
  const struck = manifest.incrementTaskAttempts(ticket);
  rotateDeadEnd({
    session,
    ticket,
    kind,
    repeatCount,
    sha,
    attempts: struck,
    killAndBootstrapNext,
  });
  return true;
}

/**
 * sendDeadEndProbe — probe path (first dead-end of this lifecycle): write the
 * diagnosed `dead-end` marker, push a diagnostic prompt into the agent pane, and
 * emit a `dead-end-probe` alert telling the operator to wait for the reply. No
 * kill, no rotation, and — crucially — NO attempt bump (a probe is not a strike).
 *
 * `attempts` is the CURRENT (un-incremented) cross-lifecycle strike count. The
 * display strike is `attempts + 1` — the strike this lifecycle's kill would land
 * on — so the operator sees how close the ticket is to `blocked`.
 */
function sendDeadEndProbe({ session, ticket, kind, repeatCount, sha, attempts, alert }) {
  const strike = attempts + 1;
  state.write(ticket, 'dead-end', {
    diagnosed: true,
    diagnosedAt: state.now(),
    trigger: kind,
    attempts,
  });
  const probe = `MAESTRO DIAGNOSTIC (strike ${strike}/${DEAD_END_MAX_ATTEMPTS}): you have been stalled on ${kind} for ${repeatCount}+ cycles. Reply with: (1) what step/phase you are on, (2) the exact prompt or condition blocking you, (3) what input or decision you need from the operator. Do NOT take any other action.`;
  try {
    spawnSync('tmux', ['send-keys', '-t', session, probe, 'Enter'], { stdio: 'ignore' });
  } catch {}
  manifest.updateTaskStatus(
    ticket,
    'in_progress',
    `dead-end probe sent (strike ${strike}/${DEAD_END_MAX_ATTEMPTS}); waiting for agent reply`
  );
  alerts.log(
    `${session} DEAD-END strike ${strike}/${DEAD_END_MAX_ATTEMPTS} — diagnostic probe sent to agent; NO kill, NO rotation. Operator should read pane reply via tmux capture-pane.`,
    { kind: 'log-only' } // the kind=dead-end-probe alert() below carries the wake
  );
  alert({
    session,
    ticket,
    kind: 'dead-end-probe',
    trigger: kind,
    repeatCount,
    sha,
    attempts,
    unblockCmd: `tmux capture-pane -t ${session} -p | tail -40`,
    instruction: `Strike ${strike}/${DEAD_END_MAX_ATTEMPTS}: agent received a diagnostic prompt asking what's blocking. Wait for the reply, then capture the pane: tmux capture-pane -t ${session} -p | tail -40. If the reply is actionable, intervene; otherwise the next dead-end re-emit (after the grace window) rotates the slot.`,
  });
}

/**
 * rotateDeadEnd — kill path: write the killed `dead-end` marker then
 * kill+rotate. Status is `blocked` once attempts hit DEAD_END_MAX_ATTEMPTS,
 * else `pending` (re-eligible for a later bootstrap).
 */
function rotateDeadEnd({
  session,
  ticket,
  kind,
  repeatCount,
  sha,
  attempts,
  killAndBootstrapNext,
}) {
  const exhausted = attempts >= DEAD_END_MAX_ATTEMPTS;
  state.write(ticket, 'dead-end', {
    killed: true,
    freedAt: state.now(),
    trigger: kind,
    attempts,
  });
  killAndBootstrapNext({
    session,
    ticket,
    alertKind: 'dead-end',
    manifestStatus: exhausted ? 'blocked' : 'pending',
    manifestNote: exhausted
      ? `dead-end after ${kind} ×${repeatCount}; ${attempts} attempts exhausted`
      : `dead-end after ${kind} ×${repeatCount}; attempt ${attempts}/${DEAD_END_MAX_ATTEMPTS}, re-eligible`,
    logPrefix: `DEAD-END ${kind} re-fired ${repeatCount}x (attempt ${attempts}/${DEAD_END_MAX_ATTEMPTS}) — `,
    alertExtra: { trigger: kind, repeatCount, sha, attempts, exhausted },
    purgeCounts: true,
  });
}

module.exports = {
  DEAD_END_MAX_ATTEMPTS,
  DEAD_END_PROBE_GRACE_MIN,
  freeDeadEndSlot,
};
