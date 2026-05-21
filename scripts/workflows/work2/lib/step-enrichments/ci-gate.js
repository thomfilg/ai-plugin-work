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

function dispatchAdvanceGate(safeName, ctx, deps) {
  const { workDir } = deps;

  try {
    const { getPRInfo, checkCI } = require(path.join(workDir, 'scripts', 'follow-up-pr.js'));
    const prInfo = getPRInfo();
    if (!prInfo || !prInfo.number) return null;

    // CI must have actually gone green at some point. We require a real
    // `checkCI` => 'passing' read REGARDLESS of merge state.
    //
    // Why this is non-negotiable: a merged PR is NOT proof that CI passed —
    // admins can override, branch-protection can be relaxed, auto-merge can
    // race with required-checks updates, and historically (see ECHO-4451)
    // ci-gate was silently advancing on `state === 'MERGED'` while the
    // follow-up PR's checks were still pending and merge status was
    // BLOCKED. Trusting upstream "merged" as a CI proxy meant the workflow
    // marked ci:completed without ever observing a green build.
    //
    // The gate now always asks GitHub for the actual check rollup. If the
    // checks aren't passing, fall through so the ci step's agent (ci-runner
    // / ci-triager) is dispatched to wait + verify. Falling through is the
    // safe failure mode: it gives the agent a chance to surface the issue
    // rather than silently completing the step.
    //
    // Merge requirement: CI passing alone is NOT enough — the PR must also
    // be MERGED before we declare the `ci` step complete. The agent's job
    // ends at "code shipped to base branch," not "code ready to ship."
    // Advancing on an unmerged PR caused the workflow to report `complete`
    // while PR #1869 was still open (see triage echo-4448-issue-1). Without
    // the merge requirement, the workflow declares success on work that may
    // never land (PR closed without merge, conflicts blocking merge, review
    // not yet granted). Both conditions are independent and BOTH are required:
    //   - `ci.status === 'passing'` — checks went green (independent verify)
    //   - `prInfo.state === 'MERGED'` — code actually shipped
    const ci = checkCI(prInfo.number);
    if (ci && ci.status === 'passing' && prInfo.state === 'MERGED') {
      return advanceToCleanup(safeName, deps, 'CI passing and PR merged');
    }
  } catch {
    // Can't check PR/CI state — fall through to normal transition
  }

  return null;
}

module.exports = { dispatchAdvanceGate };
