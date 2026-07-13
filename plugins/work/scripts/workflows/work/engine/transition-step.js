/**
 * transition-step.js
 *
 * Handles the state machine transition command. Validates transitions
 * against the step registry, enforces TDD gates, DEFER re-evaluation
 * gates, the check-to-PR quality gate, and a generic step-verify gate
 * (GH-260). Persists state changes. Gate logic lives in
 * transition-gates.js.
 *
 * Exposes two functions:
 *   - transitionStep(ticket, targetStep, deps)
 *   - getAvailableTransitions(ticket, deps)
 */

const path = require('path');
const { computeTaskNum, runTransitionGates, cleanStaleTddEvidence } = require(
  path.join(__dirname, 'transition-gates')
);
const { computeGateInputHashes } = require(path.join(__dirname, '..', 'lib', 'gate-input-hashes'));

/** Fresh work state for a first-ever transition. */
function initialTransitionState(deps, safeTicket) {
  const ws = {
    ticketId: safeTicket,
    description: '',
    currentStep: 1,
    status: 'in_progress',
    stepStatus: {},
    checkProgress: {},
    errors: [],
    startTime: new Date().toISOString(),
    lastUpdate: new Date().toISOString(),
  };
  deps.ALL_STEPS.forEach((s) => {
    ws.stepStatus[s] = 'pending';
  });
  deps.appendAction(safeTicket, { step: deps.STEPS.ticket, what: 'workflow started' });
  return ws;
}

/** Going backward (retry loop): reset intermediates + archive their artifacts. */
function resetIntermediateSteps(ctx, currentIdx, targetIdx) {
  const { ws, currentStep, safeTicket, deps } = ctx;
  const stepsToReset = [];
  for (let i = targetIdx + 1; i <= currentIdx; i++) {
    ws.stepStatus[deps.ALL_STEPS[i]] = 'pending';
    stepsToReset.push(deps.ALL_STEPS[i]);
    deps.appendAction(safeTicket, { step: deps.ALL_STEPS[i], what: 'step reset' });
  }
  const tasksDir = path.join(deps.TASKS_BASE, safeTicket);
  const archivePath = deps.archiveStepArtifacts(tasksDir, stepsToReset);
  if (archivePath) {
    deps.appendAction(safeTicket, {
      step: currentStep,
      what: `artifacts archived to ${archivePath}`,
    });
  }
  ws.deferredSteps = [];
  ws.lastPlanTimestamp = null;
}

/** Going forward: mark skipped pending intermediates as completed (deferred). */
function completeSkippedSteps(ctx, currentIdx, targetIdx) {
  const { ws, safeTicket, deps } = ctx;
  for (let i = currentIdx + 1; i < targetIdx; i++) {
    if (ws.stepStatus[deps.ALL_STEPS[i]] === 'pending') {
      // Status stays 'completed' for backward compat with getCurrentStep/enforcement hooks.
      // Audit log records 'step deferred' to distinguish from explicitly executed steps.
      ws.stepStatus[deps.ALL_STEPS[i]] = 'completed';
      deps.appendAction(safeTicket, { step: deps.ALL_STEPS[i], what: 'step deferred' });
    }
  }
}

/**
 * GH-398 Task 7: Record gateFingerprint when transitioning a gate step to
 * completed. The current step (which gets marked completed) is the gate;
 * we fingerprint it with the plugin version + ISO timestamp.
 * GH-419: plus sha256 content hashes of the gate's input artifacts
 * (write-only audit data — nothing reads or enforces on it).
 * Back-compat: existing state files without gateFingerprints continue to
 * load — the field is created lazily here.
 */
function recordGateFingerprint(ws, currentStep, tasksDir) {
  if (
    !currentStep ||
    !currentStep.endsWith('_gate') ||
    ws.stepStatus[currentStep] !== 'completed'
  ) {
    return;
  }
  ws.gateFingerprints = ws.gateFingerprints || {};
  let pluginVersion = 'unknown';
  try {
    // __dirname = plugins/work/scripts/workflows/work/engine → repo root is 6 levels up
    pluginVersion = require(
      path.join(__dirname, '..', '..', '..', '..', '..', '..', 'package.json')
    ).version;
  } catch {
    /* fail-open: leave pluginVersion as 'unknown' */
  }
  ws.gateFingerprints[currentStep] = {
    pluginVersion,
    satisfiedAt: new Date().toISOString(),
    inputs: computeGateInputHashes(currentStep, tasksDir),
  };
}

/** Apply the validated transition: statuses, audit log, timestamps, save. */
function applyTransition(ctx) {
  const { ws, currentStep, targetStep, safeTicket, deps } = ctx;
  const currentIdx = deps.ALL_STEPS.indexOf(currentStep);
  const targetIdx = deps.ALL_STEPS.indexOf(targetStep);

  // Mark current as completed
  ws.stepStatus[currentStep] = 'completed';
  deps.appendAction(safeTicket, { step: currentStep, what: 'step completed' });

  ws.stepStatus[targetStep] = 'in_progress';
  deps.appendAction(safeTicket, { step: targetStep, what: 'step started' });

  ws.currentStep = targetIdx + 1;

  if (targetIdx < currentIdx) {
    resetIntermediateSteps(ctx, currentIdx, targetIdx);
  } else {
    completeSkippedSteps(ctx, currentIdx, targetIdx);
  }

  ws.lastTransitionTimestamp = new Date().toISOString();
  recordGateFingerprint(ws, currentStep, path.join(deps.TASKS_BASE, safeTicket));
  deps.saveWorkState(safeTicket, ws);

  const result = {
    success: true,
    from: currentStep,
    to: targetStep,
    direction: targetIdx > currentIdx ? 'forward' : 'backward',
    message: `${currentStep} → ${targetStep}`,
  };

  // GH-299: Annotate result when check-drift redirected the transition
  if (ctx.checkDriftDetected) {
    result.gate = 'check-drift';
    result.message = `New commits detected since check passed. Re-running check.`;
  }

  return result;
}

/**
 * @param {string} ticket
 * @param {string} targetStep
 * @param {object} deps - injected runtime dependencies
 */
function transitionStep(ticket, targetStep, deps) {
  const { tp, ALL_STEPS, STEP_TRANSITIONS, workflowCanTransition } = deps;

  if (!ALL_STEPS.includes(targetStep)) {
    return { error: true, message: `Invalid step: "${targetStep}"`, validSteps: ALL_STEPS };
  }

  const providerConfig = tp.getProviderConfig({ skipPrompt: true });
  const safeTicket = tp.sanitizeTicketIdForPath(ticket, providerConfig);

  const ws = deps.loadWorkState(safeTicket);
  const currentStep = deps.getCurrentStep(ws);

  if (!workflowCanTransition(currentStep, targetStep)) {
    return {
      error: true,
      message: `BLOCKED: ${currentStep} → ${targetStep}`,
      from: currentStep,
      to: targetStep,
      allowed: STEP_TRANSITIONS[currentStep] || [],
      hint: `From ${currentStep} you can go to: ${(STEP_TRANSITIONS[currentStep] || []).join(', ') || '(terminal)'}`,
    };
  }

  // Shared context for the gate chain. checkDriftGate may mutate targetStep
  // (redirect to check) and set checkDriftDetected.
  const ctx = {
    deps,
    ticket,
    safeTicket,
    ws,
    currentStep,
    targetStep,
    taskNum: computeTaskNum(ws),
    isForward: ALL_STEPS.indexOf(targetStep) > ALL_STEPS.indexOf(currentStep),
    checkDriftDetected: false,
  };

  const gateError = runTransitionGates(ctx);
  if (gateError) return gateError;

  cleanStaleTddEvidence(ctx);

  // Initialize state if needed
  if (!ctx.ws) {
    ctx.ws = initialTransitionState(deps, safeTicket);
  }

  return applyTransition(ctx);
}

function getAvailableTransitions(ticket, deps) {
  const { tp, STEP_TRANSITIONS, loadWorkState, getCurrentStep } = deps;
  const providerConfig = tp.getProviderConfig({ skipPrompt: true });
  const safeTicket = tp.sanitizeTicketIdForPath(ticket, providerConfig);
  const ws = loadWorkState(safeTicket);
  const current = getCurrentStep(ws);
  return {
    ticket,
    currentStep: current,
    status: ws?.stepStatus?.[current] || 'unknown',
    allowed: STEP_TRANSITIONS[current] || [],
    allStatuses: ws?.stepStatus || {},
  };
}

module.exports = { transitionStep, getAvailableTransitions };
