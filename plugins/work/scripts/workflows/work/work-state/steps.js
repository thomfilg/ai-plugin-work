/**
 * Step / check-progress / error / completion / resume / format helpers.
 * Extracted verbatim from work-state.js (file-size burndown) — behavior
 * unchanged; only the shared primitives are now imported from ./core and
 * ./checkpoints.
 */

'use strict';

const { STEPS, loadState, saveState, initState, autoInitTdd } = require('./core');
const { autoCompleteCheckpointTasks } = require('./checkpoints');
const { appendAction } = require('../lib/work-actions');
const { STEP_ORDER } = require('../step-registry');

/**
 * GH-339: Highest step at which a /work run may still be terminally cancelled.
 * Planning phases (through the Gherkin spec_gate) are cancellable; once tasks
 * are drafted and implementation begins, cancel is refused.
 */
const CANCELLABLE_STEP_CEILING = 'spec_gate';

/**
 * GH-339: True when `step` sits at or before the cancellable ceiling
 * (spec_gate). Steps at `tasks` and beyond (implement, …) are NOT cancellable.
 * Unknown steps are treated as non-cancellable (fail closed).
 * @param {string} step
 * @returns {boolean}
 */
function isCancellablePhase(step) {
  const ceilingIndex = STEP_ORDER.indexOf(CANCELLABLE_STEP_CEILING);
  const stepIndex = STEP_ORDER.indexOf(step);
  if (stepIndex < 0) return false;
  return stepIndex <= ceilingIndex;
}

/**
 * Derive the current step from a work-state: the first step flagged
 * 'in_progress', falling back to state.currentStep (1-indexed). Returns null
 * when neither yields a known step.
 * @param {object} state
 * @returns {string|null}
 */
function currentStepOf(state) {
  const stepStatus = state.stepStatus || {};
  const inProgress = STEP_ORDER.find((step) => stepStatus[step] === 'in_progress');
  if (inProgress) return inProgress;
  const idx = Number(state.currentStep) - 1;
  return STEP_ORDER[idx] || null;
}

/**
 * GH-339: Terminally cancel a /work run during a planning phase.
 * - Idempotent: if already cancelled, returns state untouched (reason/time
 *   preserved).
 * - Refused (returns { error }) once the run is past the spec_gate ceiling
 *   (tasks, implement, …) — status is never mutated on refusal.
 * - On success, stamps status='cancelled', cancelReason (verbatim), and an ISO
 *   cancelledTime, and persists. Never becomes 'completed'.
 * Returns { error } when no state found (caller must check).
 * @param {string} ticketId
 * @param {string} reason
 */
function cancelWork(ticketId, reason) {
  const state = loadState(ticketId);
  if (!state) {
    return { error: 'No state found' };
  }

  // Idempotent: already cancelled — return as-is, preserving original reason/time.
  if (state.status === 'cancelled') {
    return state;
  }

  const step = currentStepOf(state);
  if (!isCancellablePhase(step)) {
    return {
      error: `Cannot cancel workflow: step "${step}" is past the ${CANCELLABLE_STEP_CEILING} cancel ceiling`,
    };
  }

  state.status = 'cancelled';
  state.cancelReason = reason;
  state.cancelledTime = new Date().toISOString();

  return saveState(ticketId, state);
}

/**
 * Set step status
 */
function setStepStatus(ticketId, step, status) {
  if (!STEPS.includes(step)) {
    return {
      error: true,
      message: `Invalid step name: "${step}". Valid steps: ${STEPS.join(', ')}`,
    };
  }

  let state = loadState(ticketId);
  if (!state) {
    state = initState(ticketId);
  }

  state.stepStatus[step] = status;

  // Update current step based on what's in progress
  const stepIndex = STEPS.indexOf(step);
  if (status === 'in_progress' && stepIndex >= 0) {
    state.currentStep = stepIndex + 1;
  }

  // Auto-init TDD when entering implement step (always enforced)
  if (step === 'implement' && status === 'in_progress') {
    autoInitTdd(ticketId);
  }

  return saveState(ticketId, state);
}

/**
 * Set check agent progress
 */
function setCheckProgress(ticketId, agent, status, details = null) {
  let state = loadState(ticketId);
  if (!state) {
    state = initState(ticketId);
  }

  state.checkProgress[agent] = {
    status,
    details,
    lastUpdate: new Date().toISOString(),
  };

  return saveState(ticketId, state);
}

/**
 * Add an error to the state
 */
function addError(ticketId, step, error) {
  let state = loadState(ticketId);
  if (!state) {
    state = initState(ticketId);
  }

  state.errors.push({
    step,
    error,
    timestamp: new Date().toISOString(),
  });

  return saveState(ticketId, state);
}

/**
 * Terminal guard (GH-245): error message when tasksMeta has pending tasks,
 * null otherwise. GH-410: directive message when the only pending tasks are
 * checkpoint-kind without an APPROVED completion.check.md report.
 */
function pendingTasksMessage(state) {
  if (!state.tasksMeta || !Array.isArray(state.tasksMeta.tasks)) return null;
  const pendingTasks = state.tasksMeta.tasks.filter((t) => t.status !== 'completed');
  if (pendingTasks.length === 0) return null;
  const allCheckpoint = pendingTasks.every((t) => t && t.kind === 'checkpoint');
  return allCheckpoint
    ? `Cannot complete workflow: ${pendingTasks.length} checkpoint task(s) still pending — expected APPROVED completion.check.md to auto-close them (see GH-410)`
    : `Cannot complete workflow: ${pendingTasks.length} tasks still pending`;
}

/**
 * GH-695 step-status precondition: error message when any non-complete step
 * is not 'completed', null when the shape is genuinely terminal. Missing
 * stepStatus fails closed. WORK_OPERATOR_TOKEN=1 overrides (returns null)
 * and leaves an appendAction audit row — the documented human-shell repair
 * route (hooks reject env-prefixed agent commands, so agents can't use it).
 */
function stepPreconditionMessage(state, ticketId) {
  const stepStatus = state.stepStatus || {};
  const offenders = STEPS.filter((step) => step !== 'complete' && stepStatus[step] !== 'completed');
  if (offenders.length === 0) return null;
  if (process.env.WORK_OPERATOR_TOKEN !== '1') {
    return (
      `Cannot complete workflow: step(s) not completed: ${offenders.join(', ')} — ` +
      `drive them with work-next.js (operator repair route: WORK_OPERATOR_TOKEN=1 from a human shell, audited)`
    );
  }
  appendAction(ticketId, {
    step: 'complete',
    what: 'operator-override completion (WORK_OPERATOR_TOKEN)',
    meta: { offenders },
  });
  return null;
}

/**
 * Mark work as complete.
 * GH-106: Made idempotent — if already completed, returns existing state.
 * GH-695: Validates step preconditions — every non-complete step must already
 * be 'completed' (the legit flow always arrives at terminal in this shape;
 * transitions mark each step as they pass).
 * Returns { error: ... } when no state found (caller must check).
 */
function completeWork(ticketId) {
  let state = loadState(ticketId);
  if (!state) {
    return { error: 'No state found' };
  }

  // Idempotent: already completed, return as-is
  if (state.status === 'completed') {
    return state;
  }

  // GH-410: Auto-complete checkpoint tasks before the terminal guard so a
  // verification-only roll-up doesn't wedge the `complete` step. Persists if
  // anything changed so the audit trail survives.
  const autoClosed = autoCompleteCheckpointTasks(state, ticketId);
  if (autoClosed.length > 0) {
    saveState(ticketId, state);
  }

  const pendingMsg = pendingTasksMessage(state);
  if (pendingMsg) return { error: pendingMsg };

  const preconditionMsg = stepPreconditionMessage(state, ticketId);
  if (preconditionMsg) return { error: preconditionMsg };

  state.status = 'completed';
  state.completedTime = new Date().toISOString();
  if (!state.stepStatus) state.stepStatus = {};
  // No-op normalization in the legit flow (every step already 'completed');
  // only the audited operator override can stamp anything here.
  STEPS.forEach((step) => {
    state.stepStatus[step] = 'completed';
  });

  return saveState(ticketId, state);
}

/**
 * Get resume info - what step to resume from
 */
function getResumeInfo(ticketId) {
  const state = loadState(ticketId);
  if (!state) {
    return { exists: false };
  }

  // Find first incomplete step
  let resumeStep = null;
  let resumeStepIndex = 0;

  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    const status = state.stepStatus[step];

    if (status === 'in_progress') {
      resumeStep = step;
      resumeStepIndex = i + 1;
      break;
    } else if (status === 'pending') {
      resumeStep = step;
      resumeStepIndex = i + 1;
      break;
    }
  }

  // Check for incomplete check agents
  const incompleteChecks = [];
  for (const [agent, progress] of Object.entries(state.checkProgress || {})) {
    if (progress.status === 'in_progress' || progress.status === 'pending') {
      incompleteChecks.push(agent);
    }
  }

  return {
    exists: true,
    ticketId: state.ticketId,
    status: state.status,
    currentStep: state.currentStep,
    resumeStep,
    resumeStepIndex,
    completedSteps: STEPS.filter((s) => state.stepStatus[s] === 'completed'),
    incompleteChecks,
    lastError: state.errors.length > 0 ? state.errors[state.errors.length - 1] : null,
    lastUpdate: state.lastUpdate,
  };
}

// Status → display glyph. Extracted so formatState avoids nested ternaries
// (cognitive-complexity gate). Behavior identical to the former inline chains.
function statusIcon(status) {
  if (status === 'completed') return '✅';
  if (status === 'in_progress') return '🔄';
  if (status === 'failed') return '❌';
  return '⏳';
}

// Numbered, icon-prefixed line per workflow step.
function renderStepLines(state) {
  return STEPS.map(
    (step, index) =>
      `  ${index + 1}. ${statusIcon(state.stepStatus[step])} ${step}: ${state.stepStatus[step]}\n`
  ).join('');
}

// Optional "Check Agents" section ('' when no check progress recorded).
function renderCheckAgents(checkProgress) {
  const agents = Object.entries(checkProgress);
  if (agents.length === 0) return '';
  const rows = agents
    .map(([agent, progress]) => `  ${statusIcon(progress.status)} ${agent}: ${progress.status}\n`)
    .join('');
  return `\nCheck Agents:\n${rows}`;
}

// Optional "Recent Errors" section, last 3 ('' when none).
function renderRecentErrors(errors) {
  if (errors.length === 0) return '';
  const rows = errors
    .slice(-3)
    .map((err) => `  - [${err.step}] ${err.error}\n`)
    .join('');
  return `\nRecent Errors:\n${rows}`;
}

/**
 * Format state for display
 */
function formatState(state) {
  if (!state) {
    return 'No state found';
  }

  const header = `
Work State: ${state.ticketId}
════════════════════════════════════════════
Status: ${state.status}
Current Step: ${state.currentStep}
Started: ${state.startTime}
Last Update: ${state.lastUpdate}

Steps:
`;

  return (
    header +
    renderStepLines(state) +
    renderCheckAgents(state.checkProgress) +
    renderRecentErrors(state.errors)
  );
}

module.exports = {
  setStepStatus,
  setCheckProgress,
  addError,
  completeWork,
  cancelWork,
  isCancellablePhase,
  CANCELLABLE_STEP_CEILING,
  getResumeInfo,
  formatState,
};
