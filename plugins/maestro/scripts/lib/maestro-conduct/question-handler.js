'use strict';

/**
 * Per-tick handler for question-pending events.
 *
 * Lifted out of `maestro-conduct.js` to keep that file under the
 * max-lines budget.
 *
 * Escalation contract (GH-548 fix):
 *   - First alert waits Q_WAIT_MIN so transient prompts don't spam.
 *   - Re-emits are rate-limited to one per Q_RE_NUDGE_MIN (default 10m).
 *     The old behavior re-alerted EVERY tick, so with DEAD_END_REEMITS=3 a
 *     healthy agent waiting on a menu was killed ~2 minutes after the first
 *     alert — long before a human-paced operator could answer. Three live
 *     fleets lost agents this way (one was killed while the operator was
 *     typing into its pane).
 *   - Dead-end escalation additionally requires the question to have been
 *     pending Q_DEAD_END_MIN minutes (default 45) — a pending question means
 *     the agent is BLOCKED, not burning tokens, so rotation is a scheduling
 *     decision, not an emergency. Killing early destroys in-flight context
 *     and a fresh agent would only hit the same prompt again.
 */

const Q_RE_NUDGE_MIN = parseInt(process.env.Q_RE_NUDGE_MIN || '10', 10);
const Q_DEAD_END_MIN = parseInt(process.env.Q_DEAD_END_MIN || '45', 10);

function buildQuestionAlertPayload({ ctx, qHit, mins }) {
  return {
    session: ctx.session,
    ticket: ctx.ticket,
    kind: 'question-pending',
    phase: ctx.phase,
    skill: ctx.skill,
    command: ctx.command || null,
    commandBrief: ctx.commandBrief || null,
    elapsedMin: mins,
    options: qHit.options,
    promptKind: qHit.promptKind,
    paneTail: (ctx.pane || '').split('\n').slice(-40).join('\n'),
    instruction:
      `Agent runs /${ctx.skill || 'work'} — answer in THAT workflow's terms (commandBrief field has its summary; read the skill's SKILL.md before answering if unsure). ` +
      'UNBLOCK-PROTOCOL: refuse-bypass → verify-real-work-done → fix-artifact-NOT-gate → file-root-cause-bug. ' +
      'INTERACT-UNTIL-UNBLOCKED: after each tmux answer, capture the pane and check for the NEXT question/menu/permission prompt. ' +
      'Keep answering in a loop (read pane → send next answer) until the agent phase advances or the prompt buffer is empty ("❯" with no menu below). ' +
      'A single tmux send-keys is NOT enough — multi-question gates chain 3-5 prompts in sequence. ' +
      `Pane tail in paneTail field. Unanswered for ${Q_DEAD_END_MIN}m+ with queued work waiting → slot is rotated.`,
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
  // First alert: wait qWaitMin so transient prompts don't spam.
  if (!prev.alerted && mins < qWaitMin) return;
  // Re-emit cooldown (GH-548): the alert repeats so the operator can't ignore
  // it forever, but on a human answer cadence, not once per tick.
  if (prev.alerted && prev.lastAlertAt && state.minutesSince(prev.lastAlertAt) < Q_RE_NUDGE_MIN) {
    return;
  }
  const r = actions.alert(buildQuestionAlertPayload({ ctx, qHit, mins }));
  state.write(ctx.session, 'question', {
    startedAt: prev.startedAt,
    alerted: true,
    lastAlertAt: state.now(),
  });
  // Rotation only after a genuinely long unanswered wait. The repeat-count
  // threshold still applies on top (DEAD_END_REEMITS in the main loop).
  if (mins >= Q_DEAD_END_MIN) {
    maybeEscalateToDeadEnd(ctx, 'question-pending', r.count, null);
  }
}

module.exports = { handleQuestion, buildQuestionAlertPayload, Q_RE_NUDGE_MIN, Q_DEAD_END_MIN };
