'use strict';

/**
 * CI-gate slot rotation — LOCAL OVERRIDE.
 *
 * Operator decision: when a -work session reaches `ci` or `complete`, the
 * agent is doing zero useful work (parked at wait_merge or already done).
 * Holding the pool slot blocks queued tickets. Kill the session immediately
 * and let actions.freeDeadEndSlot() auto-bootstrap the next queued ticket
 * (requires AUTO_BOOTSTRAP_NEXT=1; otherwise just frees the slot).
 *
 * Race-with-code-checker concern from the original code is accepted as
 * operator's tradeoff — bypass-check sessions live in their own tmux
 * sessions and survive the -work kill.
 *
 * Idempotent: state.read('ci-rotated') prevents re-killing across ticks.
 * `kill-during-ci` is the kind so persisted alert counts don't collide
 * with the existing dead-end repeat counter.
 */

const CI_OR_LATER_PHASES = new Set(['ci', 'complete']);

function isReadyForRotation(phase) {
  return CI_OR_LATER_PHASES.has(phase);
}

function maybeFreeOnPrReady(_args) {
  // Phase-driven rotation handles this; pr-ready alone is not the trigger.
}

function maybeRotateOnPhase({ ctx, actions, restartEligible }) {
  if (!restartEligible(ctx.session)) return false;
  if (!CI_OR_LATER_PHASES.has(ctx.phase)) return false;
  return actions.freeDeadEndSlot({
    session: ctx.session,
    ticket: ctx.ticket,
    kind: 'kill-during-ci',
    repeatCount: 1,
    sha: ctx.phase,
  });
}

module.exports = {
  CI_OR_LATER_PHASES,
  isReadyForRotation,
  maybeFreeOnPrReady,
  maybeRotateOnPhase,
};
