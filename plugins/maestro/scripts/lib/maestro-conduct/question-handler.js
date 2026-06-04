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
      'UNBLOCK-PROTOCOL: refuse-bypass → verify-real-work-done → fix-artifact-NOT-gate → file-root-cause-bug. ' +
      'INTERACT-UNTIL-UNBLOCKED: after each tmux answer, capture the pane and check for the NEXT question/menu/permission prompt. ' +
      'Keep answering in a loop (read pane → send next answer) until the agent phase advances or the prompt buffer is empty ("❯" with no menu below). ' +
      'A single tmux send-keys is NOT enough — multi-question gates (brief_gate, scope reviews) chain 3-5 prompts in sequence. ' +
      'Pane tail in paneTail field. Each ignored repeat brings DEAD-END closer (3 repeats → DEAD-END).',
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
  // First alert: wait qWaitMin so transient prompts don't spam. After that,
  // re-emit on EVERY tick while the question stays pending — the operator
  // (orchestrator LLM) needs the INTERACT-UNTIL-UNBLOCKED instruction back
  // in context constantly to drive multi-prompt brief-gate / scope chains.
  // Each re-emit increments alert count → eventually hits DEAD_END_REEMITS,
  // so the operator can't just ignore forever.
  if (!prev.alerted && mins < qWaitMin) return;
  const r = actions.alert(buildQuestionAlertPayload({ ctx, qHit, mins }));
  state.write(ctx.session, 'question', {
    startedAt: prev.startedAt,
    alerted: true,
    lastAlertAt: state.now(),
  });
  maybeEscalateToDeadEnd(ctx, 'question-pending', r.count, null);
}

module.exports = { handleQuestion, buildQuestionAlertPayload };
