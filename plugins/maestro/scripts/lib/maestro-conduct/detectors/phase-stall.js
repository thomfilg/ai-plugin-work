/**
 * detectors/phase-stall.js
 *
 * Phase-budget exceedance. Stateful: tracks (phase,step,startedAt) per ticket.
 * Returns { hit:true } when the phase has been current longer than its budget.
 *
 * Nudge cadence is decided by the main loop via phase-registry.escalationFor()
 * — this detector only signals "over budget"; it doesn't pick the action.
 */
const state = require('../state');
const { phaseFor } = require('../phase-registry');

function detect({ ticket, phase, step }) {
  if (!phase) return { hit: false };
  // GH-514 R2/AC3: 'complete' is a healthy-idle terminal phase. Both the
  // legacy /work workflow (all stepStatus completed) and the /follow-up
  // skill (status ∈ {awaiting_ci, awaiting_user, complete}) collapse to
  // phase='complete' via the skill-registry. Treat it as non-escalating so
  // the conductor stays silent on idle agents waiting on CI/user.
  if (phase === 'complete') return { hit: false };
  const profile = phaseFor(phase);
  const prev = state.read(ticket, 'phase');
  const now = state.now();

  // Phase advanced (or first time we see it) → reset clock.
  if (!prev || prev.phase !== phase || String(prev.step) !== String(step)) {
    state.write(ticket, 'phase', { phase, step, startedAt: now, nudges: 0, lastNudgeAt: 0 });
    return { hit: false };
  }

  const elapsedMin = state.minutesSince(prev.startedAt);
  if (elapsedMin < profile.budgetMin) return { hit: false };

  return {
    hit: true,
    kind: 'phase-stall',
    elapsedMin,
    budgetMin: profile.budgetMin,
    reNudgeMin: profile.reNudgeMin,
    maxNudges: profile.maxNudges,
    marker: prev,    // give the caller the existing nudge counter
  };
}

module.exports = { name: 'phaseStall', detect };
