'use strict';

/**
 * Build the alert payload for a pr-ready or pr-broken pr-status hit.
 *
 * Lifted out of `maestro-conduct.runPrStatusDetector` so that function stays
 * under the cyclomatic-complexity cap. Both branches share the same `actions.alert`
 * surface; only the instruction string and the conditional paneTail differ.
 */

function buildPrReadyInstruction({ ctx, sHit, workSession }) {
  const sha7 = (sHit.sha || '').slice(0, 7);
  return `Spawn work-workflow:code-checker (Agent tool, keep alive in tmux until verdict) on PR #${sHit.prNumber} sha=${sha7} for ${ctx.ticket}. Reviewer must answer FOUR questions: (1) Did the agent complete every requirement/AC in the ticket? (2) Did it introduce any bug (logic errors, regressions, broken edge cases)? (3) Did it add any security vulnerability (injection, secrets, unsafe shell, path traversal)? (4) Did it bypass any /work workflow gate (state edits, set-step CLI, completion-checker skip, fake TDD evidence, --no-verify, deferral annotations)? Verdict must be APPROVED only if ALL four are clean. On NEEDS-WORK → forward verbatim findings to ${workSession} via tmux send-keys; re-run after agent pushes. On APPROVED → surface PR URL to operator; operator merges PR and kills tmux sessions ${ctx.ticket}-work + ${ctx.ticket}-listen to free the pool slot.`;
}

function buildPrBrokenInstruction({ sHit }) {
  const failingList = (sHit.failingChecks || [])
    .map((c) => `${c.name}(${c.conclusion})`)
    .join(', ');
  return `UNBLOCK-PROTOCOL: fix-in-PR (no skip, no --no-verify, no scope-creep escape). Failing: ${failingList || 'see PR'}. Never merge red.`;
}

/**
 * Build the full alert payload (caller still owns the `actions.alert` call).
 * Pane tail is only attached for pr-broken: pr-ready hands off to the
 * code-checker subagent which captures its own context.
 */
function buildPayload({ ctx, sHit, workSession, tmux }) {
  const isReady = sHit.kind === 'pr-ready';
  const instruction = isReady
    ? buildPrReadyInstruction({ ctx, sHit, workSession })
    : buildPrBrokenInstruction({ sHit });
  const paneTail = isReady
    ? undefined
    : tmux.capture(workSession).split('\n').slice(-40).join('\n');
  return {
    session: workSession,
    ticket: ctx.ticket,
    kind: sHit.kind,
    phase: ctx.phase,
    prNumber: sHit.prNumber,
    sha: sHit.sha,
    checksState: sHit.checksState,
    mergeable: sHit.mergeable,
    failingChecks: sHit.failingChecks,
    ...(paneTail ? { paneTail } : {}),
    instruction,
  };
}

module.exports = { buildPrReadyInstruction, buildPrBrokenInstruction, buildPayload };
