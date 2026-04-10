/**
 * policies/transition-gate.js
 *
 * Transition gate (Rule 2) extracted from enforce-step-workflow.js.
 *
 * Decides whether a transition command should be allowed for a given workflow:
 *   - skip if not a transition command
 *   - skip if target step is unknown
 *   - skip if target ticket differs from current
 *   - skip if current step is a soft step
 *   - allow if evidence exists for current step
 *   - allow if any verify() function returns true
 *   - otherwise BLOCK
 */

/**
 * @param {object} args
 * @param {object} args.workflow — workflow definition
 * @param {string} args.ticketId
 * @param {string|null} args.currentStep
 * @param {object} args.transition — output of parseTransition()
 * @param {object} args.evidence — loaded evidence map for this workflow
 *
 * @returns {{ blocked: boolean, skipped?: boolean, currentStep?: string, expectedLines?: string[], attemptedCmd?: string }}
 */
function evaluateTransitionGate({ workflow, ticketId, currentStep, transition, evidence }) {
  if (!transition || !transition.isTransition) {
    return { blocked: false, skipped: true };
  }

  // Validate target is a real step in this workflow
  if (!workflow.steps.includes(transition.targetStep)) {
    return { blocked: false, skipped: true };
  }

  // Ticket-aware: skip if transition targets a different ticket
  if (transition.ticket !== ticketId) {
    return { blocked: false, skipped: true };
  }

  // Soft steps don't need evidence
  if (workflow.softSteps.has(currentStep)) {
    return { blocked: false, skipped: true };
  }

  // Evidence exists → allow
  if (evidence?.[currentStep]?.executed) {
    return { blocked: false };
  }

  // Inferred evidence: check verify() functions for this step
  const verifiers = workflow.commandMap.filter(
    (m) => m.step === currentStep && typeof m.verify === 'function'
  );
  if (verifiers.some((m) => m.verify(ticketId))) {
    return { blocked: false };
  }

  // BLOCKED: build expected hint lines
  const expectedMappings = workflow.commandMap.filter((m) => m.step === currentStep);
  const expectedLines =
    expectedMappings.length > 0
      ? expectedMappings.map((m) => {
          if (typeof m.verify === 'function') return `${m.step} (inferred via verify)`;
          const toolLabel = Array.isArray(m.tool) ? m.tool.join('/') : m.tool;
          if (m.field == null) return `${toolLabel} (any call)`;
          const pat = m.pattern ? m.pattern.toString() : '(any)';
          return `${toolLabel}.${m.field} matches ${pat}`;
        })
      : [`No registered command for step '${currentStep}' — add to softSteps or commandMap.`];

  return {
    blocked: true,
    currentStep,
    expectedLines,
    attemptedCmd: transition.raw || '(unknown)',
  };
}

/**
 * Format the user-facing block message for a transition gate failure.
 */
function formatTransitionBlockMessage({ workflowName, currentStep, attemptedCmd, expectedLines }) {
  return (
    `BLOCKED [${workflowName}]: Cannot transition from ${currentStep} — expected command not executed.\n` +
    `Attempted: ${attemptedCmd}\n` +
    `Expected one of:\n` +
    expectedLines.map((s) => `  - ${s}\n`).join('') +
    `Run the expected command first, then transition.\n`
  );
}

module.exports = {
  evaluateTransitionGate,
  formatTransitionBlockMessage,
};
