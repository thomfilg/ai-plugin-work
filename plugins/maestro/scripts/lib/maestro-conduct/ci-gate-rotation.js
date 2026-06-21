'use strict';

/**
 * CI-gate slot rotation — LOCAL OVERRIDE.
 *
 * Operator decision: when a -work session reaches `ci` or `complete`, the
 * agent is doing zero useful work (parked at wait_merge or already done).
 * Holding the pool slot blocks queued tickets. Delegate to
 * actions.freeCiPhaseSlot(), which kills the session IMMEDIATELY on the first
 * tick (no diagnostic probe, no attempt counter) and auto-bootstraps the next
 * queued ticket (requires AUTO_BOOTSTRAP_NEXT=1; otherwise just frees the slot).
 *
 * Race-with-code-checker concern from the original code is accepted as
 * operator's tradeoff — bypass-check sessions live in their own tmux
 * sessions and survive the -work kill.
 *
 * Idempotent: freeCiPhaseSlot's `ci-rotated` marker prevents re-killing across
 * ticks. `kill-during-ci` is the alert kind so persisted alert counts don't
 * collide with the existing dead-end repeat counter. Gated by the CI-gate
 * feature's own AUTO_FREE_CI_SLOT (NOT AUTO_FREE_DEAD_END).
 */

const CI_OR_LATER_PHASES = new Set(['ci', 'complete']);

function isReadyForRotation(phase) {
  return CI_OR_LATER_PHASES.has(phase);
}

function maybeFreeOnPrReady(_args) {
  // Phase-driven rotation handles this; pr-ready alone is not the trigger.
}

function maybeRotateOnPhase({ ctx, state: _state, actions, restartEligible }) {
  if (!restartEligible(ctx.session)) return false;
  if (!CI_OR_LATER_PHASES.has(ctx.phase)) return false;
  return actions.freeCiPhaseSlot({ session: ctx.session, ticket: ctx.ticket, phase: ctx.phase });
}

module.exports = {
  CI_OR_LATER_PHASES,
  isReadyForRotation,
  maybeFreeOnPrReady,
  maybeRotateOnPhase,
};
