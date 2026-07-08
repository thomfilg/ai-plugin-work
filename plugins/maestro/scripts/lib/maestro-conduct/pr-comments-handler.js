'use strict';

/**
 * Per-tick handler for pr-comments-stuck escalations.
 *
 * Lifted out of `maestro-conduct.js` so that file stays under the
 * max-lines-per-function / file budget. Behavior is unchanged: walks the
 * stall escalation ladder (soft → interrupt → alert) on the per-phase
 * cooldown, then advances the marker.
 */

function buildReason(cHit) {
  const top = cHit.summary
    .map((s) => `${s.file}:${s.line} [${s.severity || '?'}] ${s.title}`)
    .join(' | ');
  return `PR #${cHit.prNumber} has ${cHit.count} unaddressed bot comment(s), HEAD unchanged ${cHit.minsStuck}m. Top: ${top}`;
}

function emitAlert({ ctx, cHit, actions, maybeEscalateToDeadEnd }) {
  const r = actions.alert({
    session: ctx.session,
    ticket: ctx.ticket,
    kind: 'pr-comments-stuck',
    phase: ctx.phase,
    skill: ctx.skill,
    prNumber: cHit.prNumber,
    count: cHit.count,
    elapsedMin: cHit.minsStuck,
    summary: cHit.summary,
    paneTail: (ctx.pane || '').split('\n').slice(-40).join('\n'),
    instruction: `agent left ${cHit.count} bot comment(s) on PR #${cHit.prNumber} unaddressed for ${cHit.minsStuck}m, HEAD unchanged. Address each bot comment in the PR (never blanket-dismiss as stale). Pane tail in paneTail field.`,
  });
  maybeEscalateToDeadEnd(ctx, 'pr-comments-stuck', r.count, null);
}

// A fix→push→re-comment cycle count at/above this is a LOOP (GH-627): the
// agent keeps "addressing" comments and the bot keeps re-flagging — nudging
// it to address them AGAIN is what drives the loop. Escalate to the operator
// instead.
const COMMENT_LOOP_CYCLES = parseInt(process.env.COMMENT_LOOP_CYCLES || '3', 10);
const COMMENT_LOOP_RE_EMIT_MIN = parseInt(process.env.COMMENT_LOOP_RE_EMIT_MIN || '60', 10);

function maybeEmitCommentLoop({ ctx, cHit, state, actions }) {
  const loop = state.read(ctx.ticket, 'pr-comments-loop') || {};
  if ((loop.cycles || 0) < COMMENT_LOOP_CYCLES) return false;
  if (loop.lastAlertAt && state.minutesSince(loop.lastAlertAt) < COMMENT_LOOP_RE_EMIT_MIN) {
    return true; // still looping — stay silent, but suppress nudges
  }
  state.write(ctx.ticket, 'pr-comments-loop', { ...loop, lastAlertAt: state.now() });
  actions.alert({
    session: ctx.session,
    ticket: ctx.ticket,
    kind: 'comment-loop',
    phase: ctx.phase,
    skill: ctx.skill,
    prNumber: cHit.prNumber,
    count: cHit.count,
    cycles: loop.cycles,
    summary: cHit.summary,
    unblockCmd: `gh pr view ${cHit.prNumber} --comments | tail -80   # judge the threads yourself`,
    instruction:
      `LOOP: PR #${cHit.prNumber} has gone through ${loop.cycles} fix→push→re-comment cycles and still shows ${cHit.count} bot comment(s). ` +
      'The agent addressing them again will NOT converge — a reviewer-bot nitpick loop is invisible to count-based nudging. ' +
      'Operator: read the threads, decide fix-vs-false-positive per comment (never blanket-dismiss), and either give the agent a specific directive or take the judgment call out of its hands.',
  });
  return true;
}

function handlePrComments({
  ctx,
  cHit,
  state,
  actions,
  phaseFor,
  escalationFor,
  bumpMarker,
  maybeEscalateToDeadEnd,
}) {
  // LOOPING beats nudging: once the cycle counter trips, more nudges only
  // feed the loop (GH-627 "a looping agent looked busy").
  if (maybeEmitCommentLoop({ ctx, cHit, state, actions })) return;

  const marker = cHit.marker;
  const sinceLastNudge = marker.lastNudgeAt ? state.minutesSince(marker.lastNudgeAt) : Infinity;
  const profile = phaseFor(ctx.phase);
  if (marker.lastNudgeAt && sinceLastNudge < profile.reNudgeMin) return;

  const nudges = marker.nudges || 0;
  const reason = buildReason(cHit);
  const escalation = escalationFor(ctx.phase, nudges);

  // Branch order differs from detector-runners.handlePhaseStall on purpose
  // (jscpd would flag the shared alert/interrupt/soft ladder as a clone).
  if (escalation === 'soft') {
    actions.soft(ctx.session, reason, ctx.skill);
  } else if (escalation === 'interrupt') {
    actions.interrupt(ctx.session, reason, ctx.skill);
  } else {
    emitAlert({ ctx, cHit, actions, maybeEscalateToDeadEnd });
  }
  bumpMarker(ctx.ticket, 'pr-comments', marker, escalation === 'alert');
}

module.exports = { handlePrComments, buildReason };
