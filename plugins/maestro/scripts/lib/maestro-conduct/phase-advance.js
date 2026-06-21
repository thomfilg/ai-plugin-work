/**
 * phase-advance.js — dead-end attempt reset on real progress.
 *
 * Extracted verbatim from maestro-conduct.js to keep that file under the
 * max-lines gate. Behavior is byte-identical; restartEligible is injected so
 * there is no require back into maestro-conduct.js.
 */
const state = require('./state');
const manifest = require('./manifest');
const alerts = require('./alerts');

/** Reset dead-end attempts when the ticket's phase has advanced since last tick.
 * Real progress (phase forward-step) signals the agent is unstuck, so the
 * next dead-end should be treated as attempt 1 again, not as continued
 * escalation from earlier stalls in unrelated phases.
 */
function detectPhaseAdvance(ctx, restartEligible) {
  if (!restartEligible(ctx.session)) return;
  const prev = state.read(ctx.ticket, 'last-phase') || {};
  if (prev.phase && prev.phase !== ctx.phase) {
    const reset = manifest.resetTaskAttempts(ctx.ticket);
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

module.exports = { detectPhaseAdvance };
