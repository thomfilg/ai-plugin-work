/**
 * Follow-up dispatch-advance gate.
 *
 * When .follow-up2-state.json shows status: "complete",
 * advances work state directly to ci (bypasses transition-step.js
 * which would call isPRGateReady and potentially hang).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ALL_STEPS } = require(path.join(__dirname, '..', '..', '..', 'work', 'step-registry'));

/**
 * @param {string} safeName
 * @param {object} ctx
 * @param {object} deps
 * @returns {null | { recurse: true } | object}
 */
function dispatchAdvanceGate(safeName, ctx, deps) {
  const { loadWorkState, saveWorkState, log, recursionDepth } = deps;

  const followUpStatePath = path.join(ctx.tasksDir, '.follow-up2-state.json');
  let followUpState;
  try {
    followUpState = JSON.parse(fs.readFileSync(followUpStatePath, 'utf8'));
  } catch {
    return null; // no state file — let orchestrator re-dispatch
  }

  if (followUpState.status !== 'complete') return null;

  const ws = loadWorkState(safeName);
  if (!ws) return null;

  // Advance: follow_up → ci
  ws.stepStatus.follow_up = 'completed';
  ws.currentStep = ALL_STEPS.indexOf('ci') + 1;
  ws.stepStatus.ci = 'in_progress';
  delete ws._work2Dispatched;
  delete ws._work2DispatchedAction;
  saveWorkState(safeName, ws);

  if (log) {
    log.recurse(recursionDepth, 'follow_up→ci (follow-up2 complete)');
  }

  return { recurse: true };
}

module.exports = { dispatchAdvanceGate };
