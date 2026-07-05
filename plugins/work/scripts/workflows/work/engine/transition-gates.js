/**
 * transition-gates.js
 *
 * The gate checks run by transition-step.js before a transition is applied:
 * TDD evidence, multi-task completion, DEFER re-evaluation, the check-to-PR
 * quality gate, check-drift detection (GH-299), and the generic step-verify
 * gate (GH-260).
 *
 * Each gate takes the shared transition context and returns an error result
 * to surface, or null to proceed. `runTransitionGates` chains them in order.
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
    // Steps after check, excluding:
    //   - 'complete' (terminal step)
    //   - post-merge steps 'cleanup' and 'reports' (echo-4465 issue 5): once
    //     the PR is merged, HEAD legitimately moves (merge commit, main
    //     pull) — firing the drift gate from cleanup/reports rewound a
    //     COMPLETED check back to in_progress and looped /check2 ("Already
    //     complete") forever. Drift detection is only meaningful while the
    //     verified code can still change before merge (pr/ready/follow_up/ci).
    _postCheckSteps = new Set(
      allSteps
        .slice(checkIdx + 1)
        .filter((s) => s !== STEPS.complete && s !== STEPS.cleanup && s !== STEPS.reports)
    );
  }
  return _postCheckSteps;
}

/**
 * Extract 1-indexed task number from work state for per-task TDD paths (GH-219 Task 2).
 * Clamp to totalTasks so that when currentTaskIndex points past the end (all tasks done),
 * the TDD gate re-checks the LAST task's evidence instead of a non-existent task N+1.
 */
function computeTaskNum(ws) {
  return ws?.tasksMeta?.currentTaskIndex != null
    ? Math.min(ws.tasksMeta.currentTaskIndex + 1, ws.tasksMeta.tasks?.length ?? Infinity) ||
        undefined
    : undefined;
}

/** Checkpoint tasks skip TDD entirely — they verify, they don't write code. */
function isCheckpointTask(ctx) {
  const { taskNum, safeTicket, deps } = ctx;
  if (!taskNum) return false;
  try {
    const tasksFile = path.join(deps.TASKS_BASE, safeTicket, 'tasks.md');
    const content = fs.readFileSync(tasksFile, 'utf8');
    const m = content.match(
      new RegExp(`## Task ${taskNum}\\b[\\s\\S]*?### Type\\s*\\n(\\w+)`, 'm')
    );
    return m && m[1].trim().toLowerCase() === 'checkpoint';
  } catch {
    return false;
  }
}

function missingTddEvidenceMessage(ctx) {
  const { currentStep, taskNum, safeTicket, deps } = ctx;
  const taskLabel = taskNum ? ` for task ${taskNum}` : '';
  // /work flow: implement-gate.js runs the task's `### Test Command` and
  // writes tdd-phase.json itself. Agents must NOT invoke tdd-phase-state.js
  // (the legacy CLI) — its writes to tdd-phase.json are blocked by the
  // protect-orchestrator-state hook. Surface the gate-driven failure modes
  // and the diagnostic that's actually available (state file).
  const wsPath = path.join(deps.TASKS_BASE, safeTicket, '.work-state.json');
  return [
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
}

/**
 * TDD gate: require evidence before leaving gated steps (always enforced).
 * NOTE: This validates TDD evidence for the CURRENT task only (per
 * tasksMeta.currentTaskIndex). The multi-task gate separately blocks leaving
 * implement when tasks remain.
 */
function tddGate(ctx) {
  const { currentStep, targetStep, taskNum, safeTicket, deps } = ctx;
  if (!deps.TDD_GATED_STEPS.includes(currentStep) || currentStep === targetStep) return null;
  if (isCheckpointTask(ctx)) return null;
  const { exists, parseError, evidence } = deps.readTddEvidence(safeTicket, currentStep, taskNum);
  if (!exists || parseError) {
    return { error: true, message: missingTddEvidenceMessage(ctx) };
  }
  const validation = deps.validateTddEvidence(evidence);
  if (!validation.valid) {
    return { error: true, message: `TDD evidence invalid: ${validation.reason}` };
  }
  return null;
}

/**
 * Multi-task gate: block leaving implement until ALL tasks are done.
 * This MUST be in transition-step.js (not just implement-gate.js) because the
 * dispatch-advance gate only runs when transition FAILS. Without this guard,
 * transition succeeds after any single task's TDD evidence passes and remaining
 * tasks are silently skipped. work's implement-gate.js handles advancing the
 * task pointer; this guard ensures the transition itself is blocked.
 */
function multiTaskGate(ctx) {
  const { ws, currentStep, targetStep, deps } = ctx;
  if (currentStep !== deps.STEPS.implement || currentStep === targetStep) return null;
  if (!ws?.tasksMeta || !Array.isArray(ws.tasksMeta.tasks)) return null;
  const currentIdx = ws.tasksMeta.currentTaskIndex ?? 0;
  const totalTasks = ws.tasksMeta.tasks.length;
  if (currentIdx >= totalTasks - 1) return null;
  return {
    error: true,
    message: `Cannot leave implement: task ${currentIdx + 1}/${totalTasks} done, ${totalTasks - currentIdx - 1} tasks remaining. Advance to next task first.`,
    gate: 'multi-task',
  };
}

/** DEFER re-evaluation gate (GH-154). */
function deferGate(ctx) {
  const { ws, currentStep, targetStep, isForward, ticket, deps } = ctx;
  const deferredSteps = Array.isArray(ws?.deferredSteps) ? ws.deferredSteps : [];
  if (!isForward || deferredSteps.length === 0) return null;
  const currentIdxGate = deps.ALL_STEPS.indexOf(currentStep);
  const targetIdxGate = deps.ALL_STEPS.indexOf(targetStep);
  const deferredInRange = deferredSteps.filter((ds) => {
    const idx = deps.ALL_STEPS.indexOf(ds);
    return idx > currentIdxGate && idx <= targetIdxGate;
  });
  if (deferredInRange.length === 0) return null;
  const planTs = ws.lastPlanTimestamp;
  const transTs = ws.lastTransitionTimestamp;
  if (planTs && !(transTs && planTs <= transTs)) return null;
  return {
    error: true,
    message: `BLOCKED: Cannot transition past DEFER step '${deferredInRange[0]}' -- plan must be re-run first.`,
    gate: 'defer-reeval',
    deferStep: deferredInRange[0],
    hint: `Re-run the plan to re-evaluate DEFER steps:\n  node ${path.resolve(__dirname, 'work.workflow.js')} plan ${ticket}`,
  };
}

/**
 * Check-to-PR gate (GH-121). On a passing forward check → pr transition,
 * also records checkPassedSha (GH-299) — only when getHeadSha returns a
 * valid SHA; otherwise any existing value is preserved to avoid disabling
 * drift detection when git is temporarily unavailable.
 */
function checkToPrGate(ctx) {
  const { ws, currentStep, targetStep, isForward, safeTicket, deps } = ctx;
  const isCheckToPr = currentStep === deps.STEPS.check && targetStep === deps.STEPS.pr;
  if (!isCheckToPr) return null;
  const checkGate = deps.validateCheckGate(safeTicket);
  if (!checkGate.valid) {
    return {
      error: true,
      message: `BLOCKED: check -> pr -- quality gate not satisfied`,
      gate: 'check-to-pr',
      reasons: checkGate.reasons,
      hint: 'Wait for all check agents to finish and ensure reports pass before transitioning to pr.',
    };
  }
  if (isForward) {
    const sha = deps.getHeadSha(process.cwd());
    if (sha) ws.checkPassedSha = sha;
    ws.checkInterruptedStep = null;
  }
  return null;
}

/**
 * GH-299: Check-drift gate — detect HEAD drift on forward transitions from
 * post-check steps. If new commits landed since check passed, redirect back
 * to check. Runs BEFORE step-verify so that drift detection fires even when
 * the current step's verify() would fail (e.g., follow_up verify returns
 * false but HEAD drifted).
 *
 * On drift, mutates ctx (targetStep → check, checkDriftDetected = true).
 */
function hasCheckDrift(ctx) {
  const { ws, currentStep, isForward, deps } = ctx;
  const driftEligible =
    isForward &&
    getPostCheckSteps(deps.ALL_STEPS, deps.STEPS).has(currentStep) &&
    ws?.checkPassedSha &&
    SHA_REGEX.test(ws.checkPassedSha);
  if (!driftEligible) return false;
  const headSha = deps.getHeadSha(process.cwd());
  return headSha != null && headSha !== ws.checkPassedSha;
}

function checkDriftGate(ctx) {
  const { ws, currentStep, safeTicket, deps } = ctx;
  if (!hasCheckDrift(ctx)) return null;
  // Validate redirected edge before mutating state
  if (!deps.workflowCanTransition(currentStep, deps.STEPS.check)) {
    return {
      error: true,
      message: `BLOCKED: cannot transition from ${currentStep} to ${deps.STEPS.check}`,
      allowed: deps.STEP_TRANSITIONS[currentStep] || [],
    };
  }
  // Edge validated — now mutate state and redirect
  ws.checkInterruptedStep = currentStep;
  ws.checkPassedSha = null;
  // GH-329: archive stale .check.md reports so the next /check verify starts
  // fresh. Mirrors the backward-transition archival pattern; single
  // source of truth lives in lib/artifact-archival.js.
  const tasksDir = path.join(deps.TASKS_BASE, safeTicket);
  const archivePath = deps.archiveStepArtifacts(tasksDir, [deps.STEPS.check]);
  if (archivePath) {
    deps.appendAction(safeTicket, {
      step: currentStep,
      what: `artifacts archived to ${archivePath} (check-drift)`,
    });
  }
  deps.appendAction(safeTicket, {
    step: currentStep,
    what: 'check re-triggered: new commits detected',
  });
  ctx.targetStep = deps.STEPS.check;
  ctx.checkDriftDetected = true;
  return null;
}

/**
 * GH-260: Generic step-verify gate — run the step's verify() function before
 * allowing forward transitions out of non-soft steps. This catches bypasses
 * for follow_up, ci, and any other step with a verify() in workflow-definition.js.
 * The TDD and check-to-PR gates remain as explicit fast-path checks with
 * better error messages; this gate acts as a universal catch-all.
 * Skipped when check-drift redirected targetStep (backward transition to check).
 */
function stepVerifyGate(ctx) {
  const { currentStep, targetStep, isForward, checkDriftDetected, safeTicket, deps } = ctx;
  const applies =
    isForward &&
    !checkDriftDetected &&
    !deps.softSteps.has(currentStep) &&
    !deps.TDD_GATED_STEPS.includes(currentStep);
  if (!applies) return null;
  const entry = deps.commandMap.find(
    (c) => c.step === currentStep && typeof c.verify === 'function'
  );
  if (!entry) return null;
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
  if (verified) return null;
  return {
    error: true,
    message: `BLOCKED: ${currentStep} not verified — cannot transition to ${targetStep}`,
    gate: 'step-verify',
    step: currentStep,
    hint: `The ${currentStep} step has not passed its verification check. Complete the step requirements before transitioning.`,
  };
}

/** Run every gate in order. Returns the first error result, or null. */
function runTransitionGates(ctx) {
  return (
    tddGate(ctx) ||
    multiTaskGate(ctx) ||
    deferGate(ctx) ||
    checkToPrGate(ctx) ||
    checkDriftGate(ctx) ||
    stepVerifyGate(ctx) ||
    null
  );
}

/** Stale evidence cleanup when transitioning INTO a gated step. */
function cleanStaleTddEvidence(ctx) {
  const { targetStep, taskNum, safeTicket, deps } = ctx;
  if (!deps.TDD_GATED_STEPS.includes(targetStep)) return;
  try {
    const segment = taskNum != null ? [taskSegment(taskNum), 'tdd-phase.json'] : ['tdd-phase.json'];
    fs.unlinkSync(path.join(deps.TASKS_BASE, safeTicket, ...segment));
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

module.exports = { computeTaskNum, runTransitionGates, cleanStaleTddEvidence };
