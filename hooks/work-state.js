#!/usr/bin/env node

/**
 * Work State Machine Helper
 *
 * Manages persistent state for /work command to enable resume on context loss.
 * State is stored in: {TASKS_BASE}/{TICKET_ID}/.work-state.json
 *
 * Usage:
 *   node work-state.js init PROJ-815
 *   node work-state.js get PROJ-815
 *   node work-state.js set-step PROJ-815 implement in_progress
 *   node work-state.js set-check PROJ-815 qa_as_dashboard in_progress
 *   node work-state.js complete PROJ-815
 */

const fs = require('fs');
const path = require('path');

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

let config;
try {
  config = require('../lib/config');
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND' && /['"]\.\.\/lib\/config['"]/.test(err.message)) {
    config = null;
  } else {
    throw err;
  }
}
if (!config) process.exit(0);

const TASKS_BASE = config.TASKS_BASE;

const { ALL_STEPS: STEPS } = require(path.join(__dirname, '..', 'lib', 'step-registry'));

const CHECK_AGENTS = [
  'quality_checker',
  'code_checker',
  'completion_checker'
  // QA agents are dynamic based on impacted apps
];

/**
 * Get state file path for a ticket
 */
function getStatePath(ticketId) {
  return path.join(TASKS_BASE, ticketId, '.work-state.json');
}

/**
 * Load state for a ticket
 */
function loadState(ticketId) {
  const statePath = getStatePath(ticketId);
  if (fs.existsSync(statePath)) {
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Save state for a ticket
 */
function saveState(ticketId, state) {
  const taskDir = path.join(TASKS_BASE, ticketId);
  if (!fs.existsSync(taskDir)) {
    fs.mkdirSync(taskDir, { recursive: true });
  }

  state.lastUpdate = new Date().toISOString();
  const statePath = getStatePath(ticketId);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
}

/**
 * Initialize a new work state
 */
function initState(ticketId, description = '') {
  // Idempotent: return existing state if already initialized.
  // loadState() safely returns null on corrupt JSON (try-catch guarded).
  const existing = loadState(ticketId);
  if (existing) return existing;

  const stepStatus = {};
  STEPS.forEach(step => {
    stepStatus[step] = 'pending';
  });

  const state = {
    ticketId,
    description,
    currentStep: 1,
    status: 'in_progress',
    stepStatus,
    checkProgress: {},
    testEnhancement: {
      initialRating: 0,
      finalRating: 0,
      iterations: 0,
      skipped: false,
      skipReason: null
    },
    errors: [],
    startTime: new Date().toISOString(),
    lastUpdate: new Date().toISOString()
  };

  return saveState(ticketId, state);
}

/**
 * Set step status
 */
function setStepStatus(ticketId, step, status) {
  if (!STEPS.includes(step)) {
    return { error: true, message: `Invalid step name: "${step}". Valid steps: ${STEPS.join(', ')}` };
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
    lastUpdate: new Date().toISOString()
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
    timestamp: new Date().toISOString()
  });

  return saveState(ticketId, state);
}

/**
 * Mark work as complete
 */
function completeWork(ticketId) {
  let state = loadState(ticketId);
  if (!state) {
    return { error: 'No state found' };
  }

  state.status = 'completed';
  state.completedTime = new Date().toISOString();
  STEPS.forEach(step => {
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
    completedSteps: STEPS.filter(s => state.stepStatus[s] === 'completed'),
    incompleteChecks,
    lastError: state.errors.length > 0 ? state.errors[state.errors.length - 1] : null,
    lastUpdate: state.lastUpdate
  };
}

/**
 * Format state for display
 */
function formatState(state) {
  if (!state) {
    return 'No state found';
  }

  let output = `
Work State: ${state.ticketId}
════════════════════════════════════════════
Status: ${state.status}
Current Step: ${state.currentStep}
Started: ${state.startTime}
Last Update: ${state.lastUpdate}

Steps:
`;

  STEPS.forEach((step, index) => {
    const status = state.stepStatus[step];
    const icon = status === 'completed' ? '✅' :
                 status === 'in_progress' ? '🔄' :
                 status === 'failed' ? '❌' : '⏳';
    output += `  ${index + 1}. ${icon} ${step}: ${status}\n`;
  });

  if (Object.keys(state.checkProgress).length > 0) {
    output += '\nCheck Agents:\n';
    for (const [agent, progress] of Object.entries(state.checkProgress)) {
      const icon = progress.status === 'completed' ? '✅' :
                   progress.status === 'in_progress' ? '🔄' :
                   progress.status === 'failed' ? '❌' : '⏳';
      output += `  ${icon} ${agent}: ${progress.status}\n`;
    }
  }

  if (state.errors.length > 0) {
    output += '\nRecent Errors:\n';
    state.errors.slice(-3).forEach(err => {
      output += `  - [${err.step}] ${err.error}\n`;
    });
  }

  return output;
}

// CLI handler
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const ticketId = args[1];

  if (!command) {
    console.error('Usage: node work-state.js <command> <ticket-id> [args...]');
    console.error('Commands: init, get, set-step, set-check, set-test-enhancement, add-error, complete, resume-info');
    process.exit(1);
  }

  let result;

  switch (command) {
    case 'init':
      result = initState(ticketId, args[2] || '');
      console.log(JSON.stringify(result, null, 2));
      break;

    case 'get':
      result = loadState(ticketId);
      if (args[2] === '--format') {
        console.log(formatState(result));
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
      break;

    case 'set-step':
      result = setStepStatus(ticketId, args[2], args[3]);
      if (result && result.error) {
        console.error(JSON.stringify(result));
        process.exit(1);
      }
      console.log(JSON.stringify({ success: true, step: args[2], status: args[3] }));
      break;

    case 'set-check':
      result = setCheckProgress(ticketId, args[2], args[3], args[4] ? JSON.parse(args[4]) : null);
      console.log(JSON.stringify({ success: true, agent: args[2], status: args[3] }));
      break;

    case 'set-test-enhancement':
      {
        let state = loadState(ticketId);
        if (!state) state = initState(ticketId);
        if (!state.testEnhancement) state.testEnhancement = {};

        const field = args[2];
        const value = args[3];
        // Handle boolean values
        if (value === 'true') {
          state.testEnhancement[field] = true;
        } else if (value === 'false') {
          state.testEnhancement[field] = false;
        } else if (value === 'null') {
          state.testEnhancement[field] = null;
        } else {
          state.testEnhancement[field] = isNaN(value) ? value : Number(value);
        }
        saveState(ticketId, state);
        console.log(JSON.stringify({ success: true, field, value: state.testEnhancement[field] }));
      }
      break;

    case 'add-error':
      result = addError(ticketId, args[2], args[3]);
      console.log(JSON.stringify({ success: true, error: 'added' }));
      break;

    case 'complete':
      result = completeWork(ticketId);
      console.log(JSON.stringify(result, null, 2));
      break;

    case 'resume-info':
      result = getResumeInfo(ticketId);
      console.log(JSON.stringify(result, null, 2));
      break;

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch(() => process.exit(0));

module.exports = {
  loadState,
  saveState,
  initState,
  setStepStatus,
  setCheckProgress,
  addError,
  completeWork,
  getResumeInfo,
  STEPS,
  CHECK_AGENTS
};
