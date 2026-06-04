'use strict';

/**
 * Per-tick handler for question-pending events.
 *
 * Lifted out of `maestro-conduct.js` to keep that file under the
 * max-lines budget. Behavior unchanged: tracks a per-session marker,
 * emits a structured alert with paneTail when the wait exceeds
 * Q_WAIT_MIN, and re-emits on the same cadence so the alert count can
 * escalate to DEAD-END.
 */

function buildQuestionAlertPayload({ ctx, qHit, mins }) {
  return {
    session: ctx.session,
    ticket: ctx.ticket,
    kind: 'question-pending',
    phase: ctx.phase,
    elapsedMin: mins,
    options: qHit.options,
    promptKind: qHit.promptKind,
    paneTail: (ctx.pane || '').split('\n').slice(-40).join('\n'),
    instruction:
      'UNBLOCK-PROTOCOL: refuse-bypass → verify-real-work-done → fix-artifact-NOT-gate → file-root-cause-bug. Pane tail in paneTail field. Answer within Q_WAIT_MIN (3 repeats → DEAD-END).',
  };
}

function handleQuestion({ ctx, qHit, state, actions, qWaitMin, maybeEscalateToDeadEnd }) {
  const prev = state.read(ctx.session, 'question');
  const now = state.now();
  if (!prev) {
    state.write(ctx.session, 'question', { startedAt: now, alerted: false });
    return;
  }
  const mins = state.minutesSince(prev.startedAt);
  if (mins < qWaitMin) return;
  if (prev.alerted) {
    const sinceLastAlert = prev.lastAlertAt ? state.minutesSince(prev.lastAlertAt) : Infinity;
    if (sinceLastAlert < qWaitMin) return;
  }
  const r = actions.alert(buildQuestionAlertPayload({ ctx, qHit, mins }));
  state.write(ctx.session, 'question', {
    startedAt: prev.startedAt,
    alerted: true,
    lastAlertAt: state.now(),
  });
  maybeEscalateToDeadEnd(ctx, 'question-pending', r.count, null);
}

module.exports = { handleQuestion, buildQuestionAlertPayload };
