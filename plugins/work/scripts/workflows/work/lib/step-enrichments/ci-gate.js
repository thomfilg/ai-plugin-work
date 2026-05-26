/**
 * CI dispatch-advance gate.
 *
 * Handles two cases:
 * 1. PR already merged → skip CI entirely (no checks to wait for)
 * 2. All CI checks passing → advance to cleanup
 *
 * This gate runs BEFORE transitionStep() to avoid the verify() fallback
 * path where ghExec errors cause silent false returns and infinite retries.
 */

'use strict';

const path = require('path');
const { ALL_STEPS } = require(path.join(__dirname, '..', '..', '..', 'work', 'step-registry'));

function advanceToCleanup(safeName, deps, reason) {
  const { loadWorkState, saveWorkState, log, recursionDepth } = deps;
  const ws = loadWorkState(safeName);
  if (!ws) return null;

  ws.stepStatus.ci = 'completed';
  ws.currentStep = ALL_STEPS.indexOf('cleanup') + 1;
  ws.stepStatus.cleanup = 'in_progress';
  delete ws._work2Dispatched;
  delete ws._work2DispatchedAction;
  saveWorkState(safeName, ws);

  if (log) log.recurse(recursionDepth, `ci→cleanup (${reason})`);
  return { recurse: true };
}

function rollbackToFollowUp(safeName, deps, reason) {
  const { loadWorkState, saveWorkState, log, recursionDepth } = deps;
  const ws = loadWorkState(safeName);
  if (!ws) return null;

  // Go back from `ci` to `follow_up`. This is the inverse of the normal
  // forward edge and exists for the case where the PR was sitting at `ci`
  // waiting for merge but something changed (new conflict pushed to base,
  // a reviewer requested changes, a previously-passing check went red on
  // a base-branch rebase). The orchestrator should re-run follow-up to fix
  // the new problem rather than waiting forever at `ci`.
  ws.stepStatus.ci = 'in_progress';
  ws.currentStep = ALL_STEPS.indexOf('follow_up') + 1;
  ws.stepStatus.follow_up = 'in_progress';
  delete ws._work2Dispatched;
  delete ws._work2DispatchedAction;
  saveWorkState(safeName, ws);

  if (log) log.recurse(recursionDepth, `ci→follow_up (${reason})`);
  return { recurse: true };
}

function dispatchAdvanceGate(safeName, ctx, deps) {
  const { workDir } = deps;

  try {
    const { getPRInfo } = require(path.join(workDir, 'scripts', 'follow-up-pr.js'));
    const prInfo = getPRInfo();
    if (!prInfo || !prInfo.number) return null;

    // Mergeability is the single signal: a PR is ready for the ci→cleanup
    // advance iff GitHub itself would allow a Squash-and-merge AND the PR
    // is actually MERGED. We use `pr-mergeable.assessMergeable` to mirror
    // GitHub's own merge button — `mergeStateStatus ∈ {CLEAN, UNSTABLE}`
    // AND no rollup entry is still running.
    //
    // Two regressions led here:
    //   - PR #1960: failed REQUIRED check + "Merging is blocked" but
    //     `checkCI()` returned status:'passing' (silent --required empty array).
    //   - PR #1929: 9 IN_PROGRESS checks + 2 unpushed commits but
    //     follow-up declared "Already complete" from saved state.
    // The new predicate fixes both by asking GitHub, not the workflow's
    // own intermediate state.
    //
    // Merge requirement remains independent: the agent's job ends at "code
    // shipped to base branch." Both conditions must hold:
    //   - assessMergeable.mergeable === true
    //   - prInfo.state === 'MERGED'
    const { assessMergeable, hasActionableBlockers } = require(
      path.join(__dirname, '..', 'pr-mergeable.js')
    );
    const m = assessMergeable(prInfo.number);

    // Forward edge: mergeable AND already merged → advance to cleanup.
    if (m.mergeable && prInfo.state === 'MERGED') {
      return advanceToCleanup(safeName, deps, 'Mergeable and PR merged');
    }

    // Backward edge: PR is OPEN and has REAL (non-transient) blockers —
    // conflicts, new failing checks introduced by a base-branch change,
    // reviewer requested changes. Roll back to `follow_up` so the loop
    // gets a chance to fix whatever made the PR un-mergeable.
    //
    // `hasActionableBlockers` centralises the two guards (filter gh_error
    // transients, require prState=OPEN) that this gate and follow-up-next's
    // rewind path both apply.
    const action = hasActionableBlockers(m, { prStateOverride: prInfo.state });
    if (action.actionable) {
      const reason = action.realBlockers.map((b) => b.kind).join(', ');
      return rollbackToFollowUp(safeName, deps, reason);
    }
  } catch {
    // Can't check PR/CI state — fall through to normal transition
  }

  return null;
}

module.exports = { dispatchAdvanceGate };
