/**
 * transition-step.js
 *
 * Handles the state machine transition command. Validates transitions
 * against the step registry, enforces TDD gates, DEFER re-evaluation
 * gates, and the check-to-PR quality gate. Persists state changes.
 *
 * Exposes two functions:
 *   - transitionStep(ticket, targetStep, deps)
 *   - getAvailableTransitions(ticket, deps)
 */

const fs = require('fs');
const path = require('path');
const { taskSegment } = require(path.join(__dirname, '..', 'lib', 'allocate-output-folder'));

/**
 * @param {string} ticket
 * @param {string} targetStep
 * @param {object} deps - injected runtime dependencies
 */
function transitionStep(ticket, targetStep, deps) {
  const {
    tp,
    STEPS,
    ALL_STEPS,
    STEP_TRANSITIONS,
    workflowCanTransition,
    TDD_GATED_STEPS,
    readTddEvidence,
    validateTddEvidence,
    validateCheckGate,
    archiveStepArtifacts,
    appendAction,
    loadWorkState,
    saveWorkState,
    getCurrentStep,
    TASKS_BASE,
  } = deps;

  if (!ALL_STEPS.includes(targetStep)) {
    return { error: true, message: `Invalid step: "${targetStep}"`, validSteps: ALL_STEPS };
  }

  const providerConfig = tp.getProviderConfig({ skipPrompt: true });
  const safeTicket = tp.sanitizeTicketIdForPath(ticket, providerConfig);

  let ws = loadWorkState(safeTicket);
  const currentStep = getCurrentStep(ws);

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

  // Extract 1-indexed task number from work state for per-task TDD paths (GH-219 Task 2)
  const taskNum = ws?.tasksMeta?.currentTaskIndex != null
    ? ws.tasksMeta.currentTaskIndex + 1
    : undefined;

  // TDD gate: require evidence before leaving gated steps (always enforced)
  if (TDD_GATED_STEPS.includes(currentStep) && currentStep !== targetStep) {
    const { exists, parseError, evidence } = readTddEvidence(safeTicket, currentStep, taskNum);
    if (!exists || parseError) {
      const tddStatePath = path.resolve(__dirname, '..', 'work-implement', 'tdd-phase-state.js');
      const taskFlag = taskNum ? ` --task ${taskNum}` : '';
      const msg = `Cannot leave ${currentStep} without TDD evidence. Use the TDD phase system:\n  node ${tddStatePath} init ${safeTicket}${taskFlag}\n  node ${tddStatePath} record-red ${safeTicket}${taskFlag} --cmd "<test command>"\n  node ${tddStatePath} record-green ${safeTicket}${taskFlag} --cmd "<test command>"\n  node ${tddStatePath} record-refactor ${safeTicket}${taskFlag} --cmd "<test command>"`;
      return { error: true, message: msg };
    }
    const validation = validateTddEvidence(evidence);
    if (!validation.valid) {
      return { error: true, message: `TDD evidence invalid: ${validation.reason}` };
    }
  }

  // DEFER re-evaluation gate (GH-154)
  const isForward = ALL_STEPS.indexOf(targetStep) > ALL_STEPS.indexOf(currentStep);
  const deferredSteps = Array.isArray(ws?.deferredSteps) ? ws.deferredSteps : [];
  if (isForward && deferredSteps.length > 0) {
    const currentIdxGate = ALL_STEPS.indexOf(currentStep);
    const targetIdxGate = ALL_STEPS.indexOf(targetStep);
    const deferredInRange = deferredSteps.filter((ds) => {
      const idx = ALL_STEPS.indexOf(ds);
      return idx > currentIdxGate && idx <= targetIdxGate;
    });

    if (deferredInRange.length > 0) {
      const planTs = ws.lastPlanTimestamp;
      const transTs = ws.lastTransitionTimestamp;
      if (!planTs || (transTs && planTs <= transTs)) {
        return {
          error: true,
          message: `BLOCKED: Cannot transition past DEFER step '${deferredInRange[0]}' -- plan must be re-run first.`,
          gate: 'defer-reeval',
          deferStep: deferredInRange[0],
          hint: `Re-run the plan to re-evaluate DEFER steps:\n  node ${path.resolve(__dirname, 'work.workflow.js')} plan ${ticket}`,
        };
      }
    }
  }

  // Check-to-PR gate (GH-121)
  const isCheckToPr = currentStep === STEPS.check && targetStep === STEPS.pr;
  if (isCheckToPr) {
    const checkGate = validateCheckGate(safeTicket);
    if (!checkGate.valid) {
      return {
        error: true,
        message: `BLOCKED: check -> pr -- quality gate not satisfied`,
        gate: 'check-to-pr',
        reasons: checkGate.reasons,
        hint: 'Wait for all check agents to finish and ensure reports pass before transitioning to pr.',
      };
    }
  }

  // Stale evidence cleanup when transitioning INTO a gated step
  if (TDD_GATED_STEPS.includes(targetStep)) {
    try {
      let phasePath;
      if (taskNum != null) {
        phasePath = path.join(TASKS_BASE, safeTicket, taskSegment(taskNum), 'tdd-phase.json');
      } else {
        phasePath = path.join(TASKS_BASE, safeTicket, 'tdd-phase.json');
      }
      fs.unlinkSync(phasePath);
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        /* ignore errors */
      }
    }
    try {
      const { autoInitTdd } = require(path.join(__dirname, 'work-state'));
      autoInitTdd(safeTicket, taskNum);
    } catch {
      /* fail-open */
    }
  }

  // Initialize state if needed
  if (!ws) {
    ws = {
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
    ALL_STEPS.forEach((s) => {
      ws.stepStatus[s] = 'pending';
    });
    appendAction(safeTicket, { step: STEPS.ticket, what: 'workflow started' });
  }

  const currentIdx = ALL_STEPS.indexOf(currentStep);
  const targetIdx = ALL_STEPS.indexOf(targetStep);

  // Mark current as completed
  ws.stepStatus[currentStep] = 'completed';
  appendAction(safeTicket, { step: currentStep, what: 'step completed' });

  ws.stepStatus[targetStep] = 'in_progress';
  appendAction(safeTicket, { step: targetStep, what: 'step started' });

  ws.currentStep = targetIdx + 1;

  if (targetIdx < currentIdx) {
    // Going backward (retry loop)
    const stepsToReset = [];
    for (let i = targetIdx + 1; i <= currentIdx; i++) {
      ws.stepStatus[ALL_STEPS[i]] = 'pending';
      stepsToReset.push(ALL_STEPS[i]);
      appendAction(safeTicket, { step: ALL_STEPS[i], what: 'step reset' });
    }
    const tasksDir = path.join(TASKS_BASE, safeTicket);
    const archivePath = archiveStepArtifacts(tasksDir, stepsToReset);
    if (archivePath) {
      appendAction(safeTicket, { step: currentStep, what: `artifacts archived to ${archivePath}` });
    }
    ws.deferredSteps = [];
    ws.lastPlanTimestamp = null;
  } else {
    // Going forward
    for (let i = currentIdx + 1; i < targetIdx; i++) {
      if (ws.stepStatus[ALL_STEPS[i]] === 'pending') {
        ws.stepStatus[ALL_STEPS[i]] = 'completed';
        appendAction(safeTicket, { step: ALL_STEPS[i], what: 'step skipped' });
      }
    }
  }

  ws.lastTransitionTimestamp = new Date().toISOString();
  saveWorkState(safeTicket, ws);

  return {
    success: true,
    from: currentStep,
    to: targetStep,
    direction: targetIdx > currentIdx ? 'forward' : 'backward',
    message: `${currentStep} → ${targetStep}`,
  };
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
