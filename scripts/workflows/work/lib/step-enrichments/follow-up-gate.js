/**
 * Follow-up dispatch-advance gate.
 *
 * When .follow-up-state.json shows status: "complete",
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
  const { loadWorkState, saveWorkState, log, recursionDepth, workDir } = deps;

  const followUpStatePath = path.join(ctx.tasksDir, '.follow-up-state.json');
  let followUpState;
  try {
    followUpState = JSON.parse(fs.readFileSync(followUpStatePath, 'utf8'));
  } catch {
    return null; // no state file — let orchestrator re-dispatch
  }

  if (followUpState.status !== 'complete') return null;

  // Defense-in-depth: follow-up's self-reported `status: 'complete'` is the
  // sub-orchestrator's own assertion. Before trusting it to advance the
  // outer workflow, independently verify with GitHub that the PR mirrors
  // a clickable Squash-and-merge button (mergeStateStatus ∈ {CLEAN,
  // UNSTABLE} AND no checks still running). See PR #1960 and PR #1929 —
  // both regressions advanced past this gate while GitHub was showing
  // "Merging is blocked" / "checks running".
  //
  // Fail-safe: if we can't read the rollup (network/gh error, missing
  // workDir, or missing prNumber), DO NOT advance — fall through so the
  // ci step's agent runs the real verifier. Treat any inability to
  // independently verify as "can't verify, don't advance".
  if (!workDir || !followUpState.prNumber) {
    return null;
  }
  try {
    const { assessMergeable } = require(path.join(__dirname, '..', 'pr-mergeable.js'));
    const m = assessMergeable(followUpState.prNumber);
    if (!m.mergeable) {
      return null;
    }
  } catch {
    return null;
  }

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
    log.recurse(recursionDepth, 'follow_up→ci (follow-up complete, CI verified)');
  }

  return { recurse: true };
}

module.exports = { dispatchAdvanceGate };
