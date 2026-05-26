/**
 * Check dispatch-advance gate.
 *
 * Handles two cases:
 * 1. check2 completed → advance work state to PR step
 * 2. check2 tests failed → transition back to implement
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ALL_STEPS } = require(
  path.join(__dirname, '..', '..', '..', 'work', 'step-registry')
);

/**
 * @param {string} safeName
 * @param {object} ctx
 * @param {object} deps
 * @returns {null | { recurse: true } | object}
 */
function dispatchAdvanceGate(safeName, ctx, deps) {
  const { loadWorkState, saveWorkState, log, recursionDepth } = deps;

  const checkStatePath = path.join(ctx.tasksDir, '.check2-state.json');
  let checkState;
  try {
    checkState = JSON.parse(fs.readFileSync(checkStatePath, 'utf8'));
  } catch {
    return null;
  }

  const ws = loadWorkState(safeName);
  if (!ws) return null;

  // Case 1: check2 completed successfully → advance to pr
  if (checkState.status === 'complete') {
    ws.stepStatus.check = 'completed';
    ws.currentStep = ALL_STEPS.indexOf('pr') + 1;
    ws.stepStatus.pr = 'in_progress';
    delete ws._work2Dispatched;
    delete ws._work2DispatchedAction;
    saveWorkState(safeName, ws);

    if (log) {
      log.recurse(recursionDepth, 'check→pr (check2 complete)');
    }

    return { recurse: true };
  }

  // Case 2: tests failed → transition back to implement
  if (checkState.testsFailed) {
    try {
      fs.unlinkSync(checkStatePath);
    } catch {
      /* fail-open */
    }

    ws.stepStatus.check = 'pending';
    ws.stepStatus.commit = 'pending';
    ws.stepStatus.task_review = 'pending';
    ws.stepStatus.implement = 'in_progress';
    ws.currentStep = ALL_STEPS.indexOf('implement') + 1;
    delete ws._work2Dispatched;
    delete ws._work2DispatchedAction;
    saveWorkState(safeName, ws);

    if (log) {
      log.recurse(recursionDepth, 'check→implement (tests failed)');
    }

    return { recurse: true };
  }

  return null;
}

module.exports = { dispatchAdvanceGate };
