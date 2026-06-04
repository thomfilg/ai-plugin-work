'use strict';

/**
 * CI-gate slot rotation helpers.
 *
 * Two entry points fire `actions.freeCIGateSlot`:
 *   - `maybeFreeOnPrReady`     — runs inline from the pr-status detector on
 *                                a fresh pr-ready hit. Bounded by phase so
 *                                we don't kill the agent before it has
 *                                addressed bot comments.
 *   - `maybeRotateOnPhase`     — tick-level safety net for the steady-state
 *                                pr-ready case where the detector dedups
 *                                and never re-emits; if the ticket is
 *                                already at ci-or-later and the PR is
 *                                green+clean, fire the rotation directly.
 */

// Phases that mean "agent has done its workflow work" — slot can be freed.
const CI_OR_LATER_PHASES = new Set(['ci', 'cleanup', 'reports', 'complete']);

function isReadyForRotation(sHit, phase) {
  return Boolean(
    sHit
      && sHit.checksState === 'SUCCESS'
      && sHit.mergeable === 'CLEAN'
      && CI_OR_LATER_PHASES.has(phase),
  );
}

/**
 * Pr-status-driven rotation. Called inline from the pr-ready branch.
 * `sHit.kind === 'pr-ready'` is enforced by the caller; we only re-check the
 * green+clean+phase condition here.
 */
function maybeFreeOnPrReady({ ctx, sHit, workSession, actions }) {
  if (sHit.kind !== 'pr-ready') return;
  if (!isReadyForRotation(sHit, ctx.phase)) return;
  actions.freeCIGateSlot({
    session: workSession,
    ticket: ctx.ticket,
    prNumber: sHit.prNumber,
    sha: sHit.sha,
  });
}

/**
 * Tick-level safety net (see file header). Reads the persisted `pr-status`
 * marker (`lastState`) instead of calling `prStatusDetector.detect`, because
 * the detector dedups: on the steady-state pr-ready case it returns
 * `{ hit: false }` with no `checksState`/`mergeable` fields, so calling it
 * here would never satisfy the green+clean condition.
 *
 * `lastState === 'pr-ready'` is the dedup-safe equivalent — `classify()`
 * (pr-status detector) only sets it to `'pr-ready'` when
 * `checksState === 'SUCCESS' && mergeable === 'CLEAN'`. The pr-status
 * detector runs before this function in the tick pipeline so the marker is
 * always fresh.
 */
function maybeRotateOnPhase({ ctx, state, actions, restartEligible }) {
  if (!CI_OR_LATER_PHASES.has(ctx.phase)) return;
  if (!restartEligible(ctx.session)) return;
  const ciFreed = state.read(ctx.ticket, 'ci-gate-freed') || {};
  if (ciFreed.killed) return;
  const prMarker = state.read(ctx.ticket, 'pr-status');
  if (!prMarker || prMarker.lastState !== 'pr-ready') return;
  actions.freeCIGateSlot({
    session: ctx.session,
    ticket: ctx.ticket,
    prNumber: prMarker.prNumber,
    sha: prMarker.sha,
  });
}

module.exports = {
  CI_OR_LATER_PHASES,
  isReadyForRotation,
  maybeFreeOnPrReady,
  maybeRotateOnPhase,
};
