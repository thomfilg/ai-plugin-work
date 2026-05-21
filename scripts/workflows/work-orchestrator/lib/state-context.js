/**
 * State context builder for work-next.js.
 *
 * Derives progress from work-state.json stepStatus (source of truth).
 */

'use strict';

/**
 * Build state context for instruction output.
 * @param {string} ticket
 * @param {object[]} plan - Generated plan entries
 * @param {string} safeName - Sanitized ticket name for state lookup
 * @param {object} deps - { loadWorkState, getCurrentStep, ALL_STEPS }
 * @returns {object} state context block
 */
function buildStateContext(ticket, plan, safeName, deps) {
  const { loadWorkState, getCurrentStep, ALL_STEPS } = deps;

  const ws = loadWorkState(safeName);
  const stepStatus = ws?.stepStatus || {};
  const currentStepName = ws ? getCurrentStep(ws) : null;

  const completed = ALL_STEPS.filter((s) => stepStatus[s] === 'completed');
  const currentIdx = currentStepName ? ALL_STEPS.indexOf(currentStepName) : 0;
  const remaining = ALL_STEPS.filter(
    (s) => ALL_STEPS.indexOf(s) > currentIdx && stepStatus[s] !== 'completed'
  );

  return {
    ticket,
    currentStep: currentStepName || plan[0]?.step || 'ticket',
    progress: `${completed.length + 1}/${ALL_STEPS.length}`,
    completedSteps: completed,
    remainingSteps: remaining,
  };
}

module.exports = { buildStateContext };
