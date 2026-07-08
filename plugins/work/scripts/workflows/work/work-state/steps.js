/**
 * Step / check-progress / error / completion / resume / format helpers.
 * Extracted verbatim from work-state.js (file-size burndown) — behavior
 * unchanged; only the shared primitives are now imported from ./core and
 * ./checkpoints.
 */

'use strict';

const { STEPS, loadState, saveState, initState, autoInitTdd } = require('./core');
const { autoCompleteCheckpointTasks } = require('./checkpoints');

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
 * Mark work as complete.
 * GH-106: Made idempotent — if already completed, returns existing state.
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

  // Terminal guard: block completion if tasks are still pending (GH-245).
  // GH-410: emit a directive message when the only pending tasks are
  // checkpoint-kind without an APPROVED completion.check.md report.
  if (state.tasksMeta && Array.isArray(state.tasksMeta.tasks)) {
    const pendingTasks = state.tasksMeta.tasks.filter((t) => t.status !== 'completed');
    if (pendingTasks.length > 0) {
      const allCheckpoint = pendingTasks.every((t) => t && t.kind === 'checkpoint');
      const msg = allCheckpoint
        ? `Cannot complete workflow: ${pendingTasks.length} checkpoint task(s) still pending — expected APPROVED completion.check.md to auto-close them (see GH-410)`
        : `Cannot complete workflow: ${pendingTasks.length} tasks still pending`;
      return { error: msg };
    }
  }

  state.status = 'completed';
  state.completedTime = new Date().toISOString();
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
  getResumeInfo,
  formatState,
};
