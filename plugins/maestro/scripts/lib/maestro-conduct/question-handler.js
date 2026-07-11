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

const crypto = require('crypto');

const Q_RE_NUDGE_MIN = parseInt(process.env.Q_RE_NUDGE_MIN || '10', 10);
const Q_DEAD_END_MIN = parseInt(process.env.Q_DEAD_END_MIN || '45', 10);

/**
 * Content identity for a pending prompt (GH-698 A4). The throttle key used to
 * be `session|question-pending|<phase>`, so two DIFFERENT prompts in the same
 * phase collapsed into one repeat/backoff series — the second could inherit
 * the first's throttle window and be swallowed. Hashing (phase, promptKind,
 * promptLine, options) gives each distinct prompt its own key: a fresh prompt
 * is a fresh incident (count=1 wakes immediately), while a redraw of the SAME
 * prompt keeps its series. The `❯` selection cursor is normalized out of the
 * option lines — the operator moving the cursor is the same prompt, not a new
 * one. promptLine (the matched permission line, carrying the rule name / file
 * under edit) discriminates permission prompts whose option sets are
 * identical boilerplate ("1. Yes / 2. Yes, allow all / 3. No").
 */
function promptAlertId(ctx, qHit) {
  const options = (qHit.options || []).map((o) =>
    o
      .replace(/^\s*❯\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
  const content = JSON.stringify({
    phase: ctx.phase || null,
    promptKind: qHit.promptKind || null,
    promptLine: qHit.promptLine || null,
    options,
  });
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

// Copy-paste-able unblock command (PR #603): when a numbered option is
// visible, offer the literal send-keys; otherwise offer the capture+answer
// recipe. The ❯-marked option is the agent's own recommendation.
function buildUnblockCmd(session, options) {
  const marked = (options || []).find((o) => /^❯/.test(o)) || (options || [])[0];
  const optionNum = marked && /(\d+)\./.exec(marked);
  return optionNum
    ? `tmux send-keys -t ${session} '${optionNum[1]}' Enter`
    : `tmux capture-pane -t ${session} -p | tail -40   # read prompt, then: tmux send-keys -t ${session} '<N>' Enter`;
}

function buildQuestionAlertPayload({ ctx, qHit, mins }) {
  const unblockCmd = buildUnblockCmd(ctx.session, qHit.options);
  return {
    session: ctx.session,
    ticket: ctx.ticket,
    kind: 'question-pending',
    alertId: promptAlertId(ctx, qHit),
    phase: ctx.phase,
    skill: ctx.skill,
    command: ctx.command || null,
    commandBrief: ctx.commandBrief || null,
    elapsedMin: mins,
    options: qHit.options,
    promptKind: qHit.promptKind,
    paneTail: (ctx.pane || '').split('\n').slice(-40).join('\n'),
    unblockCmd,
    instruction:
      `OPERATOR ACTION REQUIRED — agent is blocked on a ${qHit.promptKind || 'menu'} prompt. RUN NOW: ${unblockCmd}. ` +
      `Agent runs /${ctx.skill || 'work'} — answer in THAT workflow's terms (commandBrief field has its summary; read the skill's SKILL.md before answering if unsure). ` +
      'DECIDE YOURSELF — do NOT escalate workflow decisions to the user; AskUserQuestion is ONLY for product/spec intent the user explicitly owns. ' +
      'UNBLOCK-PROTOCOL: refuse-bypass → verify-real-work-done → fix-artifact-NOT-gate → file-root-cause-bug. ' +
      'INTERACT-UNTIL-UNBLOCKED: after each tmux answer, capture the pane and check for the NEXT question/menu/permission prompt. ' +
      'Keep answering in a loop (read pane → send next answer) until the agent phase advances or the prompt buffer is empty ("❯" with no menu below). ' +
      'A single tmux send-keys is NOT enough — multi-question gates chain 3-5 prompts in sequence. ' +
      'DO NOT reply with "standing by" — that is a no-op while the agent stays blocked. ' +
      `Pane tail in paneTail field. Unanswered for ${Q_DEAD_END_MIN}m+ with queued work waiting → slot is rotated (after a diagnostic probe).`,
  };
}

function handleQuestion({ ctx, qHit, state, actions, qWaitMin, maybeEscalateToDeadEnd }) {
  const prev = state.read(ctx.session, 'question');
  const now = state.now();
  if (!prev) {
    state.write(ctx.session, 'question', { startedAt: now, alerted: false });
    return;
  }
  const alertId = promptAlertId(ctx, qHit);
  const mins = state.minutesSince(prev.startedAt);
  // First alert: wait qWaitMin so transient prompts don't spam.
  if (!prev.alerted && mins < qWaitMin) return;
  // Re-emit cooldown (GH-548): the alert repeats so the operator can't ignore
  // it forever, but on a human answer cadence, not once per tick. A CHANGED
  // prompt bypasses the cooldown (GH-698 A4): multi-question gates chain
  // menus back-to-back, and prompt N+1 used to wait out prompt N's cooldown
  // before its first alert. A marker without lastAlertId (written pre-A4)
  // fails toward quiet — unknown identity is not a changed prompt. Flap risk
  // is contained at the SOURCE: question.js scopes the options payload to the
  // prompt block at the pane tail, so scrollback churn cannot mint new
  // alertIds — a changed identity here means the prompt itself changed, and
  // that genuinely deserves an immediate wake.
  const samePrompt = prev.lastAlertId === undefined || prev.lastAlertId === alertId;
  if (
    prev.alerted &&
    prev.lastAlertAt &&
    samePrompt &&
    state.minutesSince(prev.lastAlertAt) < Q_RE_NUDGE_MIN
  ) {
    return;
  }
  const r = actions.alert(buildQuestionAlertPayload({ ctx, qHit, mins }));
  state.write(ctx.session, 'question', {
    startedAt: prev.startedAt,
    alerted: true,
    lastAlertAt: state.now(),
    lastAlertId: alertId,
  });
  // Rotation only after a genuinely long unanswered wait. The repeat-count
  // threshold still applies on top (DEAD_END_REEMITS in the main loop).
  if (mins >= Q_DEAD_END_MIN) {
    maybeEscalateToDeadEnd(ctx, 'question-pending', r.count, null);
  }
}

module.exports = {
  handleQuestion,
  buildQuestionAlertPayload,
  promptAlertId,
  Q_RE_NUDGE_MIN,
  Q_DEAD_END_MIN,
};
