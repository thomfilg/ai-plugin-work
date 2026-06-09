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
    prNumber: cHit.prNumber,
    count: cHit.count,
    elapsedMin: cHit.minsStuck,
    summary: cHit.summary,
    paneTail: (ctx.pane || '').split('\n').slice(-40).join('\n'),
    instruction: `agent left ${cHit.count} bot comment(s) on PR #${cHit.prNumber} unaddressed for ${cHit.minsStuck}m, HEAD unchanged. Address each bot comment in the PR (never blanket-dismiss as stale). Pane tail in paneTail field.`,
  });
  maybeEscalateToDeadEnd(ctx, 'pr-comments-stuck', r.count, null);
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
  const marker = cHit.marker;
  const sinceLastNudge = marker.lastNudgeAt ? state.minutesSince(marker.lastNudgeAt) : Infinity;
  const profile = phaseFor(ctx.phase);
  if (marker.lastNudgeAt && sinceLastNudge < profile.reNudgeMin) return;

  const nudges = marker.nudges || 0;
  const reason = buildReason(cHit);
  const escalation = escalationFor(ctx.phase, nudges);

  if (escalation === 'alert') {
    emitAlert({ ctx, cHit, actions, maybeEscalateToDeadEnd });
  } else if (escalation === 'interrupt') {
    actions.interrupt(ctx.session, reason);
  } else {
    actions.soft(ctx.session, reason);
  }
  bumpMarker(ctx.ticket, 'pr-comments', marker, escalation === 'alert');
}

module.exports = { handlePrComments, buildReason };
