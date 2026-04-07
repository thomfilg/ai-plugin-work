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

// GH-106: CLI command is used by both the global handlers and main().catch()
// Declared at module scope so both if(require.main) blocks can access it.
const _cliCommand = require.main === module ? process.argv[2] : null;

// Scope global handlers to CLI execution only so require()ing this module
// from other scripts doesn't change their failure semantics.
if (require.main === module) {
  process.on('uncaughtException', (err) => {
    if (_cliCommand === 'complete') {
      process.stderr.write(JSON.stringify({ error: `uncaught exception: ${err?.message || err}` }) + '\n');
      process.exit(1);
    }
    process.exit(0);
  });
  process.on('unhandledRejection', (err) => {
    if (_cliCommand === 'complete') {
      process.stderr.write(JSON.stringify({ error: `unhandled rejection: ${err?.message || err}` }) + '\n');
      process.exit(1);
    }
    process.exit(0);
  });
}

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

const { ALL_STEPS: STEPS } = require(path.join(__dirname, 'step-registry'));

const SUBTASK_STEPS = ['implement', 'commit'];

const CHECK_AGENTS = [
  'quality_checker',
  'code_checker',
  'completion_checker'
  // QA agents are dynamic based on impacted apps
];

// Delegates to config.safeTicketId() — provider config is cached, resolved once per process
const safeId = config.safeTicketId;

/**
 * Get state file path for a ticket
 */
function getStatePath(ticketId) {
  return path.join(TASKS_BASE, safeId(ticketId), '.work-state.json');
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
  const taskDir = path.join(TASKS_BASE, safeId(ticketId));
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
    errors: [],
    startTime: new Date().toISOString(),
    lastUpdate: new Date().toISOString()
  };

  return saveState(ticketId, state);
}

/**
 * Auto-initialize TDD phase state when entering the implement step.
 * Creates tdd-phase.json with RED phase so the developer agent is forced
 * to write tests first. Idempotent — skips if state already exists.
 */
function autoInitTdd(ticketId) {
  let fd;
  let created = false;
  try {
    // Validate ticketId — reject traversal chars and verify resolved path stays within TASKS_BASE
    if (!ticketId || /\.\./.test(ticketId) || /\\/.test(ticketId)) return;
    const tddStatePath = path.join(TASKS_BASE, safeId(ticketId), 'tdd-phase.json');
    if (!path.resolve(tddStatePath).startsWith(path.resolve(TASKS_BASE) + path.sep)) return;
    // Create directory and write initial RED phase state
    fs.mkdirSync(path.dirname(tddStatePath), { recursive: true });
    const state = { currentPhase: 'red', currentCycle: 1, cycles: [] };
    // Atomic exclusive create: 'wx' flag fails with EEXIST if file exists (no TOCTOU)
    fd = fs.openSync(tddStatePath, 'wx');
    created = true;
    fs.writeFileSync(fd, JSON.stringify(state, null, 2));
  } catch (err) {
    if (err && err.code === 'EEXIST') return; // already initialized
    // fail-open: TDD init failure must not block step transition
    if (created) {
      try { fs.unlinkSync(path.join(TASKS_BASE, safeId(ticketId), 'tdd-phase.json')); } catch {}
    }
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
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

// ─── Subtask State Functions ─────────────────────────────────────────────────

/**
 * Get the next available subtask state file path.
 * Scans {TASKS_BASE}/{ticketId}/ for .work-state-{ticketId}-subtask-*.json
 * and returns the path with the next N.
 *
 * @param {string} ticketId
 * @returns {{ path: string, index: number }}
 */
function getNextSubtaskStatePath(ticketId) {
  const taskDir = path.join(TASKS_BASE, safeId(ticketId));
  const prefix = `.work-state-${safeId(ticketId)}-subtask-`;
  let maxIndex = 0;

  if (fs.existsSync(taskDir)) {
    const files = fs.readdirSync(taskDir);
    for (const file of files) {
      if (file.startsWith(prefix) && file.endsWith('.json')) {
        const numStr = file.slice(prefix.length, -5); // remove prefix and .json
        const num = parseInt(numStr, 10);
        if (!isNaN(num) && num > maxIndex) {
          maxIndex = num;
        }
      }
    }
  }

  const nextIndex = maxIndex + 1;
  return {
    path: path.join(taskDir, `${prefix}${nextIndex}.json`),
    index: nextIndex,
  };
}

/**
 * Initialize a subtask state (minimal step set: implement, commit).
 *
 * @param {string} ticketId - parent ticket ID
 * @param {string} description
 * @returns {object} the initialized subtask state
 */
function initSubtaskState(ticketId, description = '') {
  const { path: statePath, index } = getNextSubtaskStatePath(ticketId);
  const taskDir = path.join(TASKS_BASE, safeId(ticketId));

  if (!fs.existsSync(taskDir)) {
    fs.mkdirSync(taskDir, { recursive: true });
  }

  const stepStatus = {};
  SUBTASK_STEPS.forEach(step => {
    stepStatus[step] = 'pending';
  });

  const state = {
    ticketId,
    isSubtask: true,
    parentTicketId: ticketId,
    subtaskIndex: index,
    description,
    status: 'in_progress',
    stepStatus,
    checkProgress: {},
    errors: [],
    startTime: new Date().toISOString(),
    lastUpdate: new Date().toISOString(),
  };

  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
}

/**
 * Load the most recent subtask state for a ticket (highest N that is not completed).
 * Returns null if no active subtask exists.
 *
 * @param {string} ticketId
 * @returns {object|null}
 */
function loadActiveSubtaskState(ticketId) {
  const taskDir = path.join(TASKS_BASE, safeId(ticketId));
  const prefix = `.work-state-${safeId(ticketId)}-subtask-`;

  if (!fs.existsSync(taskDir)) return null;

  const files = fs.readdirSync(taskDir);
  let bestState = null;
  let bestIndex = -1;

  for (const file of files) {
    if (!file.startsWith(prefix) || !file.endsWith('.json')) continue;

    const numStr = file.slice(prefix.length, -5);
    const num = parseInt(numStr, 10);
    if (isNaN(num)) continue;

    try {
      const content = fs.readFileSync(path.join(taskDir, file), 'utf8');
      const state = JSON.parse(content);
      if (state.status === 'in_progress' && num > bestIndex) {
        bestState = state;
        bestIndex = num;
      }
    } catch {
      // Skip corrupt JSON files gracefully
      continue;
    }
  }

  return bestState;
}

/**
 * Mark a subtask as completed.
 *
 * @param {string} ticketId
 * @param {number} subtaskIndex
 * @returns {object} the completed subtask state
 */
function completeSubtask(ticketId, subtaskIndex) {
  const taskDir = path.join(TASKS_BASE, safeId(ticketId));
  const prefix = `.work-state-${safeId(ticketId)}-subtask-`;
  const statePath = path.join(taskDir, `${prefix}${subtaskIndex}.json`);

  if (!fs.existsSync(statePath)) {
    throw new Error(`Subtask state file not found: ${statePath}`);
  }

  let content, state;
  try {
    content = fs.readFileSync(statePath, 'utf8');
    state = JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to read subtask state: ${err.message}`);
  }

  state.status = 'completed';
  state.completedTime = new Date().toISOString();
  state.lastUpdate = new Date().toISOString();

  SUBTASK_STEPS.forEach(step => {
    state.stepStatus[step] = 'completed';
  });

  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
}

// CLI handler
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const ticketId = args[1];

  if (!command) {
    console.error('Usage: node work-state.js <command> <ticket-id> [args...]');
    console.error('Commands: init, get, set-step, set-check, add-error, complete, resume-info, init-subtask, complete-subtask, active-subtask');
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

    case 'add-error':
      result = addError(ticketId, args[2], args[3]);
      console.log(JSON.stringify({ success: true, error: 'added' }));
      break;

    case 'complete':
      result = completeWork(ticketId);
      if (result && result.error) {
        console.error(JSON.stringify(result));
        process.exit(1);
      }
      console.log(JSON.stringify(result, null, 2));
      break;

    case 'resume-info':
      result = getResumeInfo(ticketId);
      console.log(JSON.stringify(result, null, 2));
      break;

    case 'init-subtask':
      result = initSubtaskState(ticketId, args[2] || '');
      console.log(JSON.stringify(result, null, 2));
      break;

    case 'complete-subtask':
      result = completeSubtask(ticketId, parseInt(args[2], 10));
      console.log(JSON.stringify(result, null, 2));
      break;

    case 'active-subtask':
      result = loadActiveSubtaskState(ticketId);
      console.log(JSON.stringify(result, null, 2));
      break;

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    if (_cliCommand === 'complete') {
      process.stderr.write(JSON.stringify({ error: `complete failed: ${err?.message || err}` }) + '\n');
      process.exit(1);
    }
    process.exit(0);
  }); // _cliCommand is module-scoped — see top of file
}

module.exports = {
  loadState,
  saveState,
  initState,
  setStepStatus,
  setCheckProgress,
  addError,
  completeWork,
  getResumeInfo,
  getNextSubtaskStatePath,
  initSubtaskState,
  loadActiveSubtaskState,
  completeSubtask,
  autoInitTdd,
  STEPS,
  SUBTASK_STEPS,
  CHECK_AGENTS
};
