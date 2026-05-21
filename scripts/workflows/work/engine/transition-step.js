/**
 * transition-step.js
 *
 * Handles the state machine transition command. Validates transitions
 * against the step registry, enforces TDD gates, DEFER re-evaluation
 * gates, the check-to-PR quality gate, and a generic step-verify gate
 * (GH-260). Persists state changes.
 *
 * Exposes two functions:
 *   - transitionStep(ticket, targetStep, deps)
 *   - getAvailableTransitions(ticket, deps)
 */

const fs = require('fs');
const path = require('path');
const { taskSegment } = require(path.join(__dirname, '..', '..', 'lib', 'allocate-output-folder'));
const { SHA_REGEX } = require(path.join(__dirname, '..', 'lib', 'git-utils'));

/**
 * Derive the set of steps that come after `check` in the workflow.
 * Computed from the step registry rather than hardcoded, so it stays
 * in sync if steps are renamed or added (GH-299).
 * @param {string[]} allSteps - ALL_STEPS from the step registry
 * @param {object} STEPS - STEPS constants from the step registry
 * @returns {Set<string>}
 */
let _postCheckSteps = null;
function getPostCheckSteps(allSteps, STEPS) {
  if (!_postCheckSteps) {
    const checkIdx = allSteps.indexOf(STEPS.check);
    // Steps after check, excluding 'complete' (terminal step)
    _postCheckSteps = new Set(allSteps.slice(checkIdx + 1).filter((s) => s !== STEPS.complete));
  }
  return _postCheckSteps;
}

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
    // GH-260: generic step-verify gate deps
    softSteps,
    commandMap,
    // GH-299: check-drift gate dep
    getHeadSha,
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
  // Clamp to totalTasks so that when currentTaskIndex points past the end (all tasks done),
  // the TDD gate re-checks the LAST task's evidence instead of a non-existent task N+1.
  const taskNum =
    ws?.tasksMeta?.currentTaskIndex != null
      ? Math.min(ws.tasksMeta.currentTaskIndex + 1, ws.tasksMeta.tasks?.length ?? Infinity) ||
        undefined
      : undefined;

  // TDD gate: require evidence before leaving gated steps (always enforced)
  // NOTE: This validates TDD evidence for the CURRENT task only (per tasksMeta.currentTaskIndex).
  // The multi-task guard below separately blocks leaving implement when tasks remain.
  // Checkpoint tasks skip TDD entirely — they verify, they don't write code.
  const _isCheckpointTask = (() => {
    if (!taskNum) return false;
    try {
      const tasksFile = path.join(TASKS_BASE, safeTicket, 'tasks.md');
      const content = fs.readFileSync(tasksFile, 'utf8');
      const m = content.match(
        new RegExp(`## Task ${taskNum}\\b[\\s\\S]*?### Type\\s*\\n(\\w+)`, 'm')
      );
      return m && m[1].trim().toLowerCase() === 'checkpoint';
    } catch {
      return false;
    }
  })();
  if (TDD_GATED_STEPS.includes(currentStep) && currentStep !== targetStep && !_isCheckpointTask) {
    const { exists, parseError, evidence } = readTddEvidence(safeTicket, currentStep, taskNum);
    if (!exists || parseError) {
      const taskLabel = taskNum ? ` for task ${taskNum}` : '';
      // /work flow: implement-gate.js runs the task's `### Test Command` and
      // writes tdd-phase.json itself. Agents must NOT invoke tdd-phase-state.js
      // (the legacy CLI) — its writes to tdd-phase.json are blocked by the
      // protect-orchestrator-state hook. Surface the gate-driven failure modes
      // and the diagnostic that's actually available (state file).
      const wsPath = path.join(TASKS_BASE, safeTicket, '.work-state.json');
      const msg = [
        `Cannot leave ${currentStep} without TDD evidence${taskLabel}.`,
        '',
        "In /work the implement-gate runs your task's `### Test Command`",
        'automatically and writes tdd-phase.json. Agents do NOT invoke',
        'tdd-phase-state.js, and direct writes to tdd-phase.json are blocked.',
        '',
        'If the gate keeps failing, diagnose:',
        `  1. Open ${wsPath} and read \`_tddRetryReason\` /`,
        '     `_tddRetryCommand` / `_tddRetryExitCode` / `_tddRetryOutputTail`',
        '     — they name the exact gate failure.',
        `  2. Confirm tasks.md "## Task ${taskNum || '<N>'}" has a \`### Test Command\``,
        '     block with a runnable shell command.',
        '  3. Common causes: required env var (e.g. $TEST_UNIT_COMMAND) unset,',
        "     test command references files that don't exist yet, malformed",
        '     parser output (fence remnant, bare interpreter name).',
        '',
        'If the state file is corrupted and needs manual repair, stop and ask the user.',
      ].join('\n');
      return { error: true, message: msg };
    }
    const validation = validateTddEvidence(evidence);
    if (!validation.valid) {
      return { error: true, message: `TDD evidence invalid: ${validation.reason}` };
    }
  }

  // Multi-task gate: block leaving implement until ALL tasks are done.
  // This MUST be in transition-step.js (not just implement-gate.js) because the
  // dispatch-advance gate only runs when transition FAILS. Without this guard,
  // transition succeeds after any single task's TDD evidence passes and remaining
  // tasks are silently skipped. work's implement-gate.js handles advancing the
  // task pointer; this guard ensures the transition itself is blocked.
  if (currentStep === STEPS.implement && currentStep !== targetStep) {
    if (ws?.tasksMeta && Array.isArray(ws.tasksMeta.tasks)) {
      const currentIdx = ws.tasksMeta.currentTaskIndex ?? 0;
      const totalTasks = ws.tasksMeta.tasks.length;
      if (currentIdx < totalTasks - 1) {
        return {
          error: true,
          message: `Cannot leave implement: task ${currentIdx + 1}/${totalTasks} done, ${totalTasks - currentIdx - 1} tasks remaining. Advance to next task first.`,
          gate: 'multi-task',
        };
      }
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

  // GH-299: Record checkPassedSha on successful check → pr forward transition.
  // Only update if getHeadSha returns a valid SHA; otherwise preserve any existing value
  // to avoid disabling drift detection when git is temporarily unavailable.
  if (isCheckToPr && isForward) {
    const sha = getHeadSha(process.cwd());
    if (sha) ws.checkPassedSha = sha;
    ws.checkInterruptedStep = null;
  }

  // GH-299: Check-drift gate — detect HEAD drift on forward transitions from post-check steps.
  // If new commits landed since check passed, redirect back to check.
  // Runs BEFORE step-verify so that drift detection fires even when the current step's
  // verify() would fail (e.g., follow_up verify returns false but HEAD drifted).
  let checkDriftDetected = false;
  if (
    isForward &&
    getPostCheckSteps(ALL_STEPS, STEPS).has(currentStep) &&
    ws?.checkPassedSha &&
    SHA_REGEX.test(ws.checkPassedSha)
  ) {
    const headSha = getHeadSha(process.cwd());
    if (headSha != null && headSha !== ws.checkPassedSha) {
      // Validate redirected edge before mutating state
      if (!workflowCanTransition(currentStep, STEPS.check)) {
        return {
          error: true,
          message: `BLOCKED: cannot transition from ${currentStep} to ${STEPS.check}`,
          allowed: STEP_TRANSITIONS[currentStep] || [],
        };
      }
      // Edge validated — now mutate state and redirect
      ws.checkInterruptedStep = currentStep;
      ws.checkPassedSha = null;
      appendAction(safeTicket, {
        step: currentStep,
        what: 'check re-triggered: new commits detected',
      });
      targetStep = STEPS.check;
      checkDriftDetected = true;
    }
  }

  // GH-260: Generic step-verify gate — run the step's verify() function before
  // allowing forward transitions out of non-soft steps. This catches bypasses
  // for follow_up, ci, and any other step with a verify() in workflow-definition.js.
  // The TDD and check-to-PR gates above remain as explicit fast-path checks with
  // better error messages; this gate acts as a universal catch-all.
  // Skipped when check-drift redirected targetStep (backward transition to check).
  if (
    isForward &&
    !checkDriftDetected &&
    !softSteps.has(currentStep) &&
    !TDD_GATED_STEPS.includes(currentStep)
  ) {
    const entry = commandMap.find((c) => c.step === currentStep && typeof c.verify === 'function');
    if (entry) {
      let verified;
      try {
        verified = entry.verify(safeTicket);
      } catch (err) {
        const detail = err && typeof err.message === 'string' ? err.message : String(err);
        return {
          error: true,
          message: `BLOCKED: ${currentStep} verify threw — cannot transition to ${targetStep}: ${detail}`,
          gate: 'step-verify',
          step: currentStep,
          hint: `The ${currentStep} step verification encountered an error: ${detail}. Resolve the issue before transitioning.`,
        };
      }
      if (!verified) {
        return {
          error: true,
          message: `BLOCKED: ${currentStep} not verified — cannot transition to ${targetStep}`,
          gate: 'step-verify',
          step: currentStep,
          hint: `The ${currentStep} step has not passed its verification check. Complete the step requirements before transitioning.`,
        };
      }
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
      const { autoInitTdd } = require(path.join(__dirname, '..', 'work-state'));
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
        // Status stays 'completed' for backward compat with getCurrentStep/enforcement hooks.
        // Audit log records 'step deferred' to distinguish from explicitly executed steps.
        ws.stepStatus[ALL_STEPS[i]] = 'completed';
        appendAction(safeTicket, { step: ALL_STEPS[i], what: 'step deferred' });
      }
    }
  }

  ws.lastTransitionTimestamp = new Date().toISOString();
  saveWorkState(safeTicket, ws);

  const result = {
    success: true,
    from: currentStep,
    to: targetStep,
    direction: targetIdx > currentIdx ? 'forward' : 'backward',
    message: `${currentStep} → ${targetStep}`,
  };

  // GH-299: Annotate result when check-drift redirected the transition
  if (checkDriftDetected) {
    result.gate = 'check-drift';
    result.message = `New commits detected since check passed. Re-running check.`;
  }

  return result;
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
