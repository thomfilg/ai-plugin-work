/**
 * policies/workflow-loop-rules.js
 *
 * Per-workflow loop bodies for enforce-step-workflow.js:
 *
 *   PreToolUse — checkWorkflowPre(): Rule 1 (step command gate) and Rule 2
 *   (transition gate) for one workflow. Returns { message, action } when the
 *   tool use must be blocked (the hook entry owns didBlock/stderr/exit), or
 *   null to allow.
 *
 *   PostToolUse — recordWorkflowPost(): records evidence that a step's
 *   command was executed, clears evidence on backward transitions, and logs
 *   /work actions.
 *
 * The (Patch 10) target-step validation — wf.steps.includes(transition.targetStep)
 * — stays in the hook entry's loops, so both callers guard before invoking these.
 */

const { matchToolToStep, isExempt } = require('./command-matching');
const { evaluateTransitionGate, formatTransitionBlockMessage } = require('./transition-gate');
const { evaluateStepGate, formatStepBlockMessage } = require('./step-gate');
const {
  loadEvidence: loadEvidencePolicy,
  saveEvidence: saveEvidencePolicy,
  recordEvidenceEntry,
  clearBackwardEvidence,
} = require('./evidence-recorder');

// (Patch 11) Transient stderr logging gated behind debug env var
const DEBUG = !!process.env.ENFORCE_HOOK_DEBUG;

// Task/Agent tool label for the /work action log
function describeTaskAction(toolName, toolInput) {
  const label =
    toolInput?.subagent_type || String(toolInput?.description || 'unknown').substring(0, 60);
  return `${toolName}(${label})`;
}

// Log action for the /work workflow
function describeWorkAction(toolName, toolInput) {
  if (toolName === 'Skill') {
    return `Skill(${toolInput?.skill || 'unknown'})`;
  }
  if (toolName === 'Task' || toolName === 'Agent') {
    return describeTaskAction(toolName, toolInput);
  }
  if (toolName === 'Bash') {
    return String(toolInput?.command || '').substring(0, 80);
  }
  return toolName;
}

function loadEvidence(deps, ticketId, evidenceFile) {
  return loadEvidencePolicy({
    tasksBase: deps.tasksBase,
    ticketId,
    evidenceFile,
    safeTicketPath: deps.safeTicketPath,
  });
}

// Atomic evidence writes — write to tmp then rename (evidence-recorder policy)
function saveEvidence(deps, ticketId, evidenceFile, evidence) {
  saveEvidencePolicy({
    tasksBase: deps.tasksBase,
    ticketId,
    evidenceFile,
    evidence,
    safeTicketPath: deps.safeTicketPath,
  });
}

// Rule 2: transition gate for one workflow. Returns { message, action } or null.
function checkTransitionPre(deps, wf, currentStep, transition, ctx) {
  // Ticket-aware transition — skip if transition targets a different ticket
  if (transition.ticket !== ctx.ticketId) return null;

  const evidence = loadEvidence(deps, ctx.ticketId, wf.evidenceFile);
  const result = evaluateTransitionGate({
    workflow: wf,
    ticketId: ctx.ticketId,
    currentStep,
    transition,
    evidence,
  });
  if (result.skipped || !result.blocked) return null;

  return {
    message: formatTransitionBlockMessage({
      workflowName: wf.name,
      currentStep: result.currentStep,
      attemptedCmd: result.attemptedCmd,
      expectedLines: result.expectedLines,
    }),
    action:
      wf.name === 'work'
        ? {
            step: currentStep,
            what: 'BLOCKED: transition without evidence',
            meta: { rule: 2 },
          }
        : null,
  };
}

// /check agent bypass — script-driven /check state (legacy .check2-state.json
// name kept as a fallback for in-flight tickets that predate the rename)
function computeCheckStateActive(deps, wf, matchedStep, currentStep, ctx) {
  if (wf.name !== 'work' || matchedStep === currentStep) return false;
  const agentType = ctx.toolInput?.subagent_type || '';
  if (!deps.checkAgents.has(agentType)) return false;
  const checkState =
    deps.loadStateFile(ctx.ticketId, '.check-state.json') ||
    deps.loadStateFile(ctx.ticketId, '.check2-state.json');
  return checkState?.status === 'in_progress';
}

// Rule 1: step command gate for one workflow. Returns { message, action } or null.
function checkStepPre(deps, wf, currentStep, ctx) {
  const matchedStep = matchToolToStep(ctx.toolName, ctx.toolInput, wf.commandIndex);
  if (!matchedStep) return null; // Not a step command for this workflow → skip

  const stepResult = evaluateStepGate({
    workflowName: wf.name,
    matchedStep,
    currentStep,
    toolInput: ctx.toolInput,
    checkAgents: deps.checkAgents,
    checkStateActive: computeCheckStateActive(deps, wf, matchedStep, currentStep, ctx),
  });
  if (!stepResult.blocked) return null; // Matched step IS current step → allow

  const cmdDesc = stepResult.cmdDesc;
  return {
    message: formatStepBlockMessage({
      workflowName: wf.name,
      matchedStep,
      currentStep,
      cmdDesc,
      transitionHint: wf.transitionHint,
      ticketId: ctx.ticketId,
    }),
    action:
      wf.name === 'work'
        ? {
            step: matchedStep,
            what: `BLOCKED: ${String(cmdDesc).substring(0, 80)} (step ${matchedStep} not in_progress)`,
            meta: { rule: 1 },
          }
        : null,
  };
}

/**
 * Rules 1+2 for one workflow. The caller has already parsed the transition
 * and applied the (Patch 10) target-step validation.
 */
function checkWorkflowPre(deps, wf, ctx) {
  const state = deps.loadStateFile(ctx.ticketId, wf.stateFile);
  if (!state || !wf.isActive(state)) return null; // Workflow not active → skip

  const currentStep = deps.getCurrentStep(state, wf.steps);
  if (!currentStep) return null; // No step in_progress → skip

  if (isExempt(ctx.toolName, ctx.toolInput, wf.exemptPatterns)) return null;

  if (ctx.transition.isTransition) {
    // Transition commands never fall through to the step gate
    return checkTransitionPre(deps, wf, currentStep, ctx.transition, ctx);
  }

  return checkStepPre(deps, wf, currentStep, ctx);
}

// (Patch 3) Ticket-aware backward-transition evidence clearing — mirror PreToolUse
function handleTransitionPost(deps, wf, ticketId, currentStep, transition) {
  if (transition.ticket !== ticketId) return;

  if (currentStep && transition.targetStep) {
    const evidence = loadEvidence(deps, ticketId, wf.evidenceFile);
    const beforeKeys = Object.keys(evidence);
    clearBackwardEvidence({
      evidence,
      steps: wf.steps,
      currentStep,
      targetStep: transition.targetStep,
    });
    const afterKeys = Object.keys(evidence);
    if (beforeKeys.length !== afterKeys.length) {
      saveEvidence(deps, ticketId, wf.evidenceFile, evidence);
    }
  }
}

// (Patch 14) pr evidence is only recorded when .pr-update-sha matches HEAD
function shouldSkipPrEvidence(deps, wf, matchedStep, ticketId) {
  if (wf.name !== 'work' || matchedStep !== deps.prStepName) return false;
  if (deps.prShaMatchesHead(ticketId)) return false;
  if (DEBUG) process.stderr.write(`[enforce] pr: pr-update-sha missing or stale\n`);
  return true; // Skip evidence recording — PR wasn't actually updated
}

/**
 * PostToolUse body for one workflow: clear evidence on backward transitions,
 * otherwise record evidence (and the /work action log) for the matched step.
 */
function recordWorkflowPost(deps, wf, ctx) {
  const state = deps.loadStateFile(ctx.ticketId, wf.stateFile);
  if (!state || !wf.isActive(state)) return;

  const currentStep = deps.getCurrentStep(state, wf.steps);

  if (ctx.transition.isTransition) {
    handleTransitionPost(deps, wf, ctx.ticketId, currentStep, ctx.transition);
    return; // Don't also record evidence for transition commands
  }

  // Map tool call to step and record evidence
  const matchedStep = matchToolToStep(ctx.toolName, ctx.toolInput, wf.commandIndex);
  if (!matchedStep) return;

  if (shouldSkipPrEvidence(deps, wf, matchedStep, ctx.ticketId)) return;

  const evidence = loadEvidence(deps, ctx.ticketId, wf.evidenceFile);
  evidence[matchedStep] = recordEvidenceEntry({
    toolName: ctx.toolName,
    toolInput: ctx.toolInput,
  });
  saveEvidence(deps, ctx.ticketId, wf.evidenceFile, evidence);

  if (wf.name === 'work') {
    deps.appendAction(ctx.ticketId, {
      step: matchedStep,
      what: describeWorkAction(ctx.toolName, ctx.toolInput),
    });
  }
}

/**
 * Create the per-workflow rule checkers bound to the hook's runtime context.
 *
 * @param {object} deps
 * @param {Function} deps.loadStateFile
 * @param {Function} deps.getCurrentStep
 * @param {Set<string>} deps.checkAgents — CHECK_AGENTS (/check bypass)
 * @param {string} deps.tasksBase
 * @param {Function} deps.safeTicketPath
 * @param {Function} deps.appendAction — /work action log (PostToolUse only)
 * @param {string} deps.prStepName — STEPS.pr
 * @param {Function} deps.prShaMatchesHead — (Patch 14) .pr-update-sha check
 */
function createWorkflowLoopRules(deps) {
  return {
    checkWorkflowPre: (wf, ctx) => checkWorkflowPre(deps, wf, ctx),
    recordWorkflowPost: (wf, ctx) => recordWorkflowPost(deps, wf, ctx),
  };
}

module.exports = {
  createWorkflowLoopRules, // Rules 1+2 (pre) and evidence recording (post)
};
