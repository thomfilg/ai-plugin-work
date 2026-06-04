'use strict';

/**
 * CI-gate slot rotation helpers.
 *
 * NOTE (review feedback round 2): both auto-rotation entry points are now
 * no-ops. The original code intentionally removed CI-gate auto-rotation
 * because freeing the slot on `pr-ready` kills the `-work` tmux session
 * before the operator can spawn `code-checker` and forward a possible
 * NEEDS-WORK verdict back to it. Re-introducing it (even gated on phase
 * >= ci) restores the race: the kill happens in the same tick as the
 * alert, so by the time the operator reacts the session is dead.
 *
 * The PR's other throttle wins (state-change heartbeat, helper-session
 * detector skips, embedded paneTail, action_required flag) are unaffected.
 * Slot freeing remains operator-driven: the operator kills `-work` +
 * `-listen` after merging the PR.
 */

// Kept exported for downstream code that imports the set. Unused by the
// rotation helpers below now that both are no-ops.
const CI_OR_LATER_PHASES = new Set(['ci', 'cleanup', 'reports', 'complete']);

function isReadyForRotation() {
  return false;
}

// eslint-disable-next-line no-unused-vars
function maybeFreeOnPrReady(_args) {
  // Intentional no-op — see file header. Killing -work on pr-ready races
  // with code-checker spawn + NEEDS-WORK forward.
}

// eslint-disable-next-line no-unused-vars
function maybeRotateOnPhase(_args) {
  // Intentional no-op — same race as maybeFreeOnPrReady. Without an
  // operator-merged signal we can't safely fire this.
}

module.exports = {
  CI_OR_LATER_PHASES,
  isReadyForRotation,
  maybeFreeOnPrReady,
  maybeRotateOnPhase,
};
