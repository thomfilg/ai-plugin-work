/**
 * policies/step-gate.js
 *
 * Step gate (Rule 1) extracted from enforce-step-workflow.js.
 *
 * Decides whether a tool call mapped to a workflow step should be allowed:
 *   - allow if matched step IS the current in_progress step
 *   - allow if /work workflow with a /check-owned agent while /check is active
 *   - otherwise BLOCK with a transition hint
 *
 * Also exposes:
 *   - getCurrentStep(state, steps): find the in_progress step from a state object
 */

/**
 * Find the in_progress step from a workflow state object.
 * Returns the first one if multiple are in_progress (legacy data tolerance).
 */
function getCurrentStep(state, steps) {
  if (!state?.stepStatus) return null;
  const active = steps.filter((s) => state.stepStatus[s] === 'in_progress');
  return active[0] || null;
}

/**
 * @param {object} args
 * @param {string} args.workflowName
 * @param {string} args.matchedStep — the step the tool call maps to
 * @param {string} args.currentStep — the in_progress step
 * @param {object} args.toolInput
 * @param {Set<string>} args.checkAgents — agents legitimately used by /check
 * @param {boolean} args.checkStateActive — whether the /check workflow is currently in_progress
 *
 * @returns {{ blocked: boolean, matchedStep?: string, currentStep?: string, cmdDesc?: string }}
 */
function evaluateStepGate({
  workflowName,
  matchedStep,
  currentStep,
  toolInput,
  checkAgents,
  checkStateActive,
}) {
  if (matchedStep === currentStep) {
    return { blocked: false };
  }

  // /check agent bypass: when running an agent owned by /check during /work,
  // allow it if /check is currently active.
  if (workflowName === 'work') {
    const agentType = toolInput?.subagent_type || '';
    if (agentType && checkAgents.has(agentType) && checkStateActive) {
      return { blocked: false };
    }
  }

  const cmdDesc = toolInput?.command || toolInput?.skill || toolInput?.subagent_type || '(unknown)';
  return { blocked: true, matchedStep, currentStep, cmdDesc: String(cmdDesc) };
}

/**
 * Format the user-facing block message for a step-gate failure.
 */
function formatStepBlockMessage({
  workflowName,
  matchedStep,
  currentStep,
  cmdDesc,
  transitionHint,
  ticketId,
}) {
  return (
    `BLOCKED [${workflowName}]: Cannot run '${cmdDesc}' — step ${matchedStep} is not in_progress.\n` +
    `Current step: ${currentStep} (in_progress)\n` +
    `Call transition first:\n` +
    `  ${transitionHint} ${ticketId} ${matchedStep}\n`
  );
}

module.exports = {
  getCurrentStep,
  evaluateStepGate,
  formatStepBlockMessage,
};
