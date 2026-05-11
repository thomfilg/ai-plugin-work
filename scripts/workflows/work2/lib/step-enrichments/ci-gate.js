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

    // Case 1: PR already merged — skip CI
    if (prInfo.state === 'MERGED') {
      return advanceToCleanup(safeName, deps, 'PR merged, skip CI');
    }

    // Case 2: All CI checks passing — advance
    const ci = checkCI(prInfo.number);
    if (ci.status === 'passing') {
      return advanceToCleanup(safeName, deps, 'CI passing');
    }
  } catch {
    // Can't check PR/CI state — fall through to normal transition
  }

  return null;
}

module.exports = { dispatchAdvanceGate };
