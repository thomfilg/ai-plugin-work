'use strict';

/**
 * lib/engine/transition.js — step transition recording for the workflow
 * engine (extracted from workflow-engine.js).
 *
 * Handles forward/backward transitions with intermediate step handling,
 * the generic step-verify gate (GH-260), and onTransition rollback.
 */

/**
 * Build transition map from {source, targets} array.
 * @param {Array<{source: string, targets: string[]}>} transitions
 * @returns {{[key: string]: string[]}}
 */
function createStatusTransitions(transitions) {
  const map = {};
  const defined = new Set(transitions.map((t) => t.source));
  transitions.forEach((t) => {
    map[t.source] = t.targets.filter((target) => defined.has(target) && target !== t.source);
  });
  return map;
}

/**
 * Returns a validator function for checking if a transition is legal.
 * @param {{[key: string]: string[]}} statusTransitions
 * @returns {(current: string, next: string) => boolean}
 */
function canTransition(statusTransitions) {
  return (current, next) => {
    const valid = statusTransitions[current] || [];
    return valid.includes(next);
  };
}

/**
 * GH-260: Generic step-verify gate — run workflow's verifyStep callback
 * before allowing forward transitions. Blocks BEFORE any state mutation
 * (including init), so failed first transitions don't create orphan state files.
 *
 * verifyStep contract: return falsy to allow, or an object with either
 * { blocked: true } or { error: true } to block the transition.
 * Optional fields: message (string), gate (string).
 *
 * @returns {object|null} an error result to return, or null to proceed
 */
function runVerifyGate(workflow, currentStep, targetStep, instanceId) {
  let verifyResult;
  try {
    verifyResult = workflow.verifyStep(currentStep, targetStep, instanceId);
  } catch (err) {
    return {
      error: true,
      message: `BLOCKED: ${currentStep} verify threw — cannot transition to ${targetStep}: ${err && err.message ? err.message : String(err)}`,
      gate: 'step-verify',
      step: currentStep,
      from: currentStep,
      to: targetStep,
    };
  }
  if (verifyResult && (verifyResult.blocked || verifyResult.error)) {
    return {
      error: true,
      message:
        verifyResult.message ||
        `BLOCKED: ${currentStep} not verified — cannot transition to ${targetStep}`,
      gate: verifyResult.gate || 'step-verify',
      step: currentStep,
      from: currentStep,
      to: targetStep,
    };
  }
  return null;
}

/** Apply the step-status mutations for a validated transition. */
function applyTransition(ws, ctx) {
  const { allSteps, transitionMap, currentStep, targetStep, currentIdx, targetIdx } = ctx;
  // Mark current as completed, target as in_progress
  ws.stepStatus[currentStep] = 'completed';
  ws.stepStatus[targetStep] = 'in_progress';
  ws.currentStep = targetIdx + 1;

  // Auto-complete workflow when reaching a terminal step (no outgoing transitions)
  const targetTransitions = transitionMap[targetStep] || [];
  if (targetTransitions.length === 0) {
    ws.stepStatus[targetStep] = 'completed';
    ws.status = 'completed';
  }

  if (targetIdx < currentIdx) {
    // Going backward (retry loop) — reset intermediate steps
    for (let i = targetIdx + 1; i <= currentIdx; i++) {
      ws.stepStatus[allSteps[i]] = 'pending';
    }
  } else {
    // Going forward — mark skipped intermediates as completed
    for (let i = currentIdx + 1; i < targetIdx; i++) {
      if (ws.stepStatus[allSteps[i]] === 'pending') {
        ws.stepStatus[allSteps[i]] = 'completed';
      }
    }
  }
}

/**
 * Invoke workflow's onTransition callback if defined. On failure, restores
 * the pre-transition snapshot and returns an error result.
 * @returns {object|null} an error result to return, or null on success
 */
function runOnTransition(workflow, stateInstance, instanceId, ctx, preTransitionState) {
  if (typeof workflow.onTransition !== 'function') return null;
  const { currentStep, targetStep } = ctx;
  try {
    workflow.onTransition(currentStep, targetStep, instanceId, { stateInstance });
    return null;
  } catch (err) {
    // onTransition failed — full rollback to pre-transition state
    const msg = err?.message || String(err);
    process.stderr.write(`[workflow-engine] onTransition error (rolling back): ${msg}\n`);
    if (err?.stack) process.stderr.write(`[workflow-engine] ${err.stack}\n`);
    stateInstance.save(instanceId, preTransitionState);
    return {
      error: true,
      message: `Transition ${currentStep} → ${targetStep} reverted: onTransition failed — ${msg}`,
      from: currentStep,
      to: targetStep,
      rollback: true,
    }; // full state snapshot restored
  }
}

/** Reject unknown steps and illegal edges. Returns an error result or null. */
function validateTransitionRequest(transitionMap, allSteps, currentStep, targetStep) {
  if (!allSteps.includes(targetStep)) {
    return { error: true, message: `Invalid step: "${targetStep}"`, validSteps: allSteps };
  }
  const validator = canTransition(transitionMap);
  if (!validator(currentStep, targetStep)) {
    return {
      error: true,
      message: `BLOCKED: ${currentStep} → ${targetStep}`,
      from: currentStep,
      to: targetStep,
      allowed: transitionMap[currentStep] || [],
      hint: `From ${currentStep} you can go to: ${(transitionMap[currentStep] || []).join(', ') || '(terminal)'}`,
    };
  }
  return null;
}

function transitionStep(workflow, stateInstance, instanceId, targetStep) {
  const transitionMap = createStatusTransitions(workflow.transitions);
  const allSteps = workflow.steps.map((s) => s.id);

  let ws = stateInstance.load(instanceId);
  const currentStep = stateInstance.getCurrentStep(instanceId) || allSteps[0];

  const requestError = validateTransitionRequest(transitionMap, allSteps, currentStep, targetStep);
  if (requestError) return requestError;

  const currentIdx = allSteps.indexOf(currentStep);
  const targetIdx = allSteps.indexOf(targetStep);
  if (targetIdx > currentIdx && typeof workflow.verifyStep === 'function') {
    const gateError = runVerifyGate(workflow, currentStep, targetStep, instanceId);
    if (gateError) return gateError;
  }

  // Initialize state if needed (after verify gate — blocked transitions don't create state)
  if (!ws) {
    ws = stateInstance.init(instanceId, allSteps);
  }

  // Snapshot state before mutations — used for full rollback if onTransition fails
  const preTransitionState = structuredClone(ws);

  const ctx = { allSteps, transitionMap, currentStep, targetStep, currentIdx, targetIdx };
  applyTransition(ws, ctx);
  stateInstance.save(instanceId, ws);

  const callbackError = runOnTransition(
    workflow,
    stateInstance,
    instanceId,
    ctx,
    preTransitionState
  );
  if (callbackError) return callbackError;

  return {
    success: true,
    from: currentStep,
    to: targetStep,
    direction: targetIdx > currentIdx ? 'forward' : 'backward',
    message: `${currentStep} → ${targetStep}`,
  };
}

function getAvailableTransitions(workflow, stateInstance, instanceId) {
  const transitionMap = createStatusTransitions(workflow.transitions);
  const ws = stateInstance.load(instanceId);
  const current = stateInstance.getCurrentStep(instanceId) || workflow.steps[0]?.id;

  return {
    workflow: workflow.name,
    instanceId,
    currentStep: current,
    status: ws?.stepStatus?.[current] || 'unknown',
    allowed: transitionMap[current] || [],
    allStatuses: ws?.stepStatus || {},
  };
}

module.exports = {
  createStatusTransitions,
  canTransition,
  transitionStep,
  getAvailableTransitions,
};
