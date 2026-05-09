/**
 * CI dispatch-advance gate.
 *
 * Skips CI step when PR is already merged — no need to wait for checks.
 * Also skips when isPRGateReady returns ready (all checks passed).
 */

'use strict';

const path = require('path');
const { ALL_STEPS } = require(path.join(__dirname, '..', '..', '..', 'work', 'step-registry'));

function dispatchAdvanceGate(safeName, ctx, deps) {
  const { loadWorkState, saveWorkState, log, recursionDepth, workDir } = deps;

  // Check if PR is merged
  try {
    const { getPRInfo } = require(path.join(workDir, 'scripts', 'follow-up-pr.js'));
    const prInfo = getPRInfo();
    if (prInfo && prInfo.state === 'MERGED') {
      const ws = loadWorkState(safeName);
      if (!ws) return null;

      ws.stepStatus.ci = 'completed';
      ws.currentStep = ALL_STEPS.indexOf('cleanup') + 1;
      ws.stepStatus.cleanup = 'in_progress';
      delete ws._work2Dispatched;
      delete ws._work2DispatchedAction;
      saveWorkState(safeName, ws);

      if (log) log.recurse(recursionDepth, 'ci→cleanup (PR merged, skip CI)');
      return { recurse: true };
    }
  } catch {
    // Can't check PR state — fall through to normal transition
  }

  return null;
}

module.exports = { dispatchAdvanceGate };
