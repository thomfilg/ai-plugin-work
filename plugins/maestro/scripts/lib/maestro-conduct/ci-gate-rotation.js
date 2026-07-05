'use strict';

/**
 * CI-phase slot rotation (PR #603 operator decision).
 *
 * When a -work session reaches `ci` or `complete`, the agent is doing zero
 * useful work — it is parked waiting for CI/operator-merge or already done.
 * Holding the pool slot starves queued tickets (observed: slots
 * hogged for hours while the operator reviewed). Delegate to
 * actions.freeCiPhaseSlot(), which kills the session and auto-bootstraps the
 * next queued ticket (AUTO_BOOTSTRAP_NEXT=1; otherwise it just frees the slot).
 *
 * The race-with-code-checker concern from the original no-op is accepted as
 * the operator's tradeoff — bypass-check sessions live in their own tmux
 * sessions and survive the -work kill; review follow-ups relaunch via
 * bootstrap (idempotent) or `claude --continue`.
 *
 * Ordering guarantees in the tick: the stop-condition oracle runs BEFORE the
 * phase detectors (so an oracle-done ticket is marked `done`, never
 * `awaiting-merge`), and this rotation runs LAST in runPhaseDetectors so it
 * sees the freshest marker state.
 *
 * Idempotent: freeCiPhaseSlot's `ci-rotated` marker prevents re-killing across
 * ticks. `kill-during-ci` is the alert kind so persisted alert counts don't
 * collide with the dead-end repeat counter. Gated by the CI-gate feature's own
 * AUTO_FREE_CI_SLOT (NOT AUTO_FREE_DEAD_END — the two features toggle
 * independently).
 */

const CI_OR_LATER_PHASES = new Set(['ci', 'complete']);

function isReadyForRotation(phase) {
  return CI_OR_LATER_PHASES.has(phase);
}

function maybeFreeOnPrReady(_args) {
  // Phase-driven rotation handles this; pr-ready alone is not the trigger
  // (a PR can be green while the agent still has cleanup/reports phases).
}

function maybeRotateOnPhase({ ctx, state: _state, actions, restartEligible }) {
  if (!restartEligible(ctx.session)) return false;
  // Phase-based rotation is a /WORK concept. The follow-up registry row maps
  // its healthy-idle statuses (awaiting_ci/awaiting_user/complete) onto
  // phase='complete' — rotating on that would kill an agent that is
  // legitimately mid-follow-up waiting on CI and mislabel its manifest entry
  // `done`. Non-/work pools rotate via their stop-condition oracle instead.
  // Fail-closed on a missing skill: only an explicit 'work' rotates.
  if (ctx.skill !== 'work') return false;
  if (!CI_OR_LATER_PHASES.has(ctx.phase)) return false;
  return actions.freeCiPhaseSlot({ session: ctx.session, ticket: ctx.ticket, phase: ctx.phase });
}

module.exports = {
  CI_OR_LATER_PHASES,
  isReadyForRotation,
  maybeRotateOnPhase,
  maybeFreeOnPrReady,
};
