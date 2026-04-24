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
      process.stderr.write(
        JSON.stringify({ error: `uncaught exception: ${err?.message || err}` }) + '\n'
      );
      process.exit(1);
    }
    process.exit(0);
  });
  process.on('unhandledRejection', (err) => {
    if (_cliCommand === 'complete') {
      process.stderr.write(
        JSON.stringify({ error: `unhandled rejection: ${err?.message || err}` }) + '\n'
      );
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
const { taskSegment } = require('../lib/allocate-output-folder');

const SUBTASK_STEPS = ['implement', 'commit'];

const CHECK_AGENTS = [
  'quality_checker',
  'code_checker',
  'completion_checker',
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
  STEPS.forEach((step) => {
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
    lastUpdate: new Date().toISOString(),
  };

  return saveState(ticketId, state);
}

/**
 * Auto-initialize TDD phase state when entering the implement step.
 * Creates tdd-phase.json with RED phase so the developer agent is forced
 * to write tests first. Idempotent — skips if state already exists.
 * @param {string} ticketId
 * @param {number} [taskNum] - 1-indexed task number; when provided, writes to per-task path
 */
function autoInitTdd(ticketId, taskNum) {
  let fd;
  let created = false;
  let tddStatePath;
  try {
    // Validate ticketId — reject traversal chars and verify resolved path stays within TASKS_BASE
    if (!ticketId || /\.\./.test(ticketId) || /\\/.test(ticketId)) return;
    if (taskNum != null) {
      tddStatePath = path.join(
        TASKS_BASE,
        safeId(ticketId),
        taskSegment(taskNum),
        'tdd-phase.json'
      );
    } else {
      tddStatePath = path.join(TASKS_BASE, safeId(ticketId), 'tdd-phase.json');
    }
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
    if (created && tddStatePath) {
      try {
        fs.unlinkSync(tddStatePath);
      } catch {}
    }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
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

  // Terminal guard: block completion if tasks are still pending (GH-245)
  // Array.isArray guards against corrupted state files where tasksMeta.tasks is not an array
  if (state.tasksMeta && Array.isArray(state.tasksMeta.tasks)) {
    const pendingTasks = state.tasksMeta.tasks.filter((t) => t.status !== 'completed');
    if (pendingTasks.length > 0) {
      return { error: `Cannot complete workflow: ${pendingTasks.length} tasks still pending` };
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
    const icon =
      status === 'completed'
        ? '✅'
        : status === 'in_progress'
          ? '🔄'
          : status === 'failed'
            ? '❌'
            : '⏳';
    output += `  ${index + 1}. ${icon} ${step}: ${status}\n`;
  });

  if (Object.keys(state.checkProgress).length > 0) {
    output += '\nCheck Agents:\n';
    for (const [agent, progress] of Object.entries(state.checkProgress)) {
      const icon =
        progress.status === 'completed'
          ? '✅'
          : progress.status === 'in_progress'
            ? '🔄'
            : progress.status === 'failed'
              ? '❌'
              : '⏳';
      output += `  ${icon} ${agent}: ${progress.status}\n`;
    }
  }

  if (state.errors.length > 0) {
    output += '\nRecent Errors:\n';
    state.errors.slice(-3).forEach((err) => {
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
  SUBTASK_STEPS.forEach((step) => {
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

  SUBTASK_STEPS.forEach((step) => {
    state.stepStatus[step] = 'completed';
  });

  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
}

// ─── Task Progress Functions ─────────────────────────────────────────────────
// Extracted to work-state/ submodules (GH-219). Re-imported here so all
// existing consumers of work-state.js are unaffected.

const { validateTaskGraph } = require('./work-state/graph-validation');
const _taskReadiness = require('./work-state/task-readiness');
const { initTasksMeta, canStartFromState, canStart } = _taskReadiness;

/**
 * Get the current task info.
 */
function getTaskCurrent(ticketId) {
  const state = loadState(ticketId);
  if (!state?.tasksMeta) return { error: 'No task tracking initialized' };

  const meta = state.tasksMeta;
  const idx = meta.currentTaskIndex;
  if (idx >= meta.tasks.length) return { done: true, message: 'All tasks completed' };

  return {
    id: meta.tasks[idx].id,
    index: idx,
    status: meta.tasks[idx].status,
    total: meta.totalTasks,
  };
}

/**
 * Advance to the next task. Marks current as completed, moves pointer.
 * Returns the next task info or { done: true } if all tasks are complete.
 */
function advanceTask(ticketId) {
  let state = loadState(ticketId);
  if (!state?.tasksMeta) return { error: 'No task tracking initialized' };

  const meta = state.tasksMeta;
  const idx = meta.currentTaskIndex;

  // Already past the end — idempotent return
  if (idx >= meta.tasks.length) {
    return { done: true, message: 'All tasks already completed' };
  }

  // Mark current task as completed
  if (idx < meta.tasks.length) {
    meta.tasks[idx].status = 'completed';
  }

  // Advance pointer
  meta.currentTaskIndex = idx + 1;

  // GH-211: Reset fix-round counter on the NEW task so each task starts fresh
  if (meta.currentTaskIndex < meta.tasks.length) {
    meta.tasks[meta.currentTaskIndex].taskReviewFixRounds = 0;
  }

  saveState(ticketId, state);

  if (meta.currentTaskIndex >= meta.tasks.length) {
    return { done: true, message: 'All tasks completed', completedTask: idx }; // terminal — all tasks done
  }
  // Normal advance — mark current completed, move to next
  return {
    done: false,
    completedTask: idx,
    nextTask: {
      id: meta.tasks[meta.currentTaskIndex].id,
      index: meta.currentTaskIndex,
      status: meta.tasks[meta.currentTaskIndex].status,
      total: meta.totalTasks,
    },
  };
}

// ─── Task Review Fix-Round Tracking (GH-211) ────────────────────────────────

/**
 * Get the current fix-round count for the current task.
 * Returns 0 when the field is absent (new task).
 * Also returns maxFixRounds and whether max is reached.
 */
function getTaskReviewFixRounds(ticketId) {
  const state = loadState(ticketId);
  if (!state?.tasksMeta) return { error: 'No task tracking initialized' };

  const meta = state.tasksMeta;
  const idx = meta.currentTaskIndex;
  if (idx >= meta.tasks.length) return { error: 'All tasks completed, no current task' };

  const fixRounds = meta.tasks[idx].taskReviewFixRounds || 0;
  const parsed = parseInt(process.env.TASK_REVIEW_MAX_FIXES, 10);
  const maxFixRounds = Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;

  // Task review fix-round status — consumed by task-review step for escalation decisions
  return {
    fixRounds,
    maxFixRounds,
    maxReached: fixRounds >= maxFixRounds, // true when no more fix attempts allowed
    taskIndex: idx,
    taskId: meta.tasks[idx].id,
  };
}

/**
 * Increment the fix-round counter for the current task by 1 and persist.
 */
function incrementTaskReviewFixRounds(ticketId) {
  const state = loadState(ticketId);
  if (!state?.tasksMeta) return { error: 'No task tracking initialized' };

  const meta = state.tasksMeta;
  const idx = meta.currentTaskIndex;
  if (idx >= meta.tasks.length) return { error: 'All tasks completed, no current task' };

  const current = meta.tasks[idx].taskReviewFixRounds || 0;
  meta.tasks[idx].taskReviewFixRounds = current + 1;

  saveState(ticketId, state);

  return {
    fixRounds: meta.tasks[idx].taskReviewFixRounds,
    taskIndex: idx,
    taskId: meta.tasks[idx].id,
  };
}

/**
 * Reset the fix-round counter for the current task to 0 and persist.
 */
function resetTaskReviewFixRounds(ticketId) {
  const state = loadState(ticketId);
  if (!state?.tasksMeta) return { error: 'No task tracking initialized' };

  const meta = state.tasksMeta;
  const idx = meta.currentTaskIndex;
  if (idx >= meta.tasks.length) return { error: 'All tasks completed, no current task' };

  meta.tasks[idx].taskReviewFixRounds = 0;

  saveState(ticketId, state);

  return {
    fixRounds: 0,
    taskIndex: idx,
    taskId: meta.tasks[idx].id,
  };
}

/**
 * Get a specific task by index.
 */
function getTaskByIndex(ticketId, taskIndex) {
  const state = loadState(ticketId);
  if (!state?.tasksMeta) return { error: 'No task tracking initialized' };

  const idx = parseInt(taskIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= state.tasksMeta.tasks.length) {
    return {
      error: `Invalid task index: ${taskIndex}. Valid range: 0-${state.tasksMeta.tasks.length - 1}`,
    };
  }

  return {
    id: state.tasksMeta.tasks[idx].id,
    index: idx,
    status: state.tasksMeta.tasks[idx].status,
    total: state.tasksMeta.totalTasks,
  };
}

// CLI handler
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const ticketId = args[1];

  if (!command) {
    console.error('Usage: node work-state.js <command> <ticket-id> [args...]');
    console.error(
      'Commands: init, get, set-step, set-check, add-error, complete, resume-info, init-subtask, complete-subtask, active-subtask, task-init, task-current, task-advance, task-get, task-review-fix-rounds, task-review-fix-rounds-increment, task-review-fix-rounds-reset'
    );
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

    case 'task-init':
      result = initTasksMeta(ticketId, parseInt(args[2], 10));
      if (result && result.error) {
        console.error(JSON.stringify(result));
        process.exit(1);
      }
      console.log(JSON.stringify({ success: true, tasksMeta: result.tasksMeta }));
      break;

    case 'task-current':
      result = getTaskCurrent(ticketId);
      if (result && result.error) {
        console.error(JSON.stringify(result));
        process.exit(1);
      }
      console.log(JSON.stringify(result, null, 2));
      break;

    case 'task-advance':
      result = advanceTask(ticketId);
      if (result && result.error) {
        console.error(JSON.stringify(result));
        process.exit(1);
      }
      console.log(JSON.stringify(result, null, 2));
      break;

    case 'task-get':
      result = getTaskByIndex(ticketId, args[2]);
      if (result && result.error) {
        console.error(JSON.stringify(result));
        process.exit(1);
      }
      console.log(JSON.stringify(result, null, 2));
      break;

    case 'task-review-fix-rounds':
      result = getTaskReviewFixRounds(ticketId);
      if (result && result.error) {
        console.error(JSON.stringify(result));
        process.exit(1);
      }
      console.log(JSON.stringify(result, null, 2));
      break;

    case 'task-review-fix-rounds-increment':
      result = incrementTaskReviewFixRounds(ticketId);
      if (result && result.error) {
        console.error(JSON.stringify(result));
        process.exit(1);
      }
      console.log(JSON.stringify(result, null, 2));
      break;

    case 'task-review-fix-rounds-reset':
      result = resetTaskReviewFixRounds(ticketId);
      if (result && result.error) {
        console.error(JSON.stringify(result));
        process.exit(1);
      }
      console.log(JSON.stringify(result, null, 2));
      break;

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

// ─── Task claim locks (GH-219 Task 6) ───────────────────────────────────────
// Per-task atomic claim semantics live in `./work-claims.js`. We re-export
// `claimTask` / `releaseTask` here so downstream CLI and hook consumers can
// import a single "work state" surface, and so the spec verification
// checklist grep for `/claimTask/` and `/\.claims/` in work-state.js is
// satisfied without duplicating the implementation.
// Claim lock files live at `TASKS_BASE/<ticketId>/.claims/task-${n}.lock`.
let claimTask, releaseTask;
try {
  ({ claimTask, releaseTask } = require('./work-claims'));
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND' && /['"]\.\/work-claims['"]/.test(err.message)) {
    // work-claims.js ships in a separate PR (PR 2b). When absent, claim
    // re-exports are undefined — callers that need claims must depend on PR 2b.
    // Only swallow MODULE_NOT_FOUND for './work-claims' itself — rethrow if a
    // transitive dependency inside work-claims is missing (runtime bug).
    claimTask = undefined;
    releaseTask = undefined;
  } else {
    throw err;
  }
}

// ─── Parallel worker PR{N} slot allocation (GH-219 Task 7) ─────────────────
// Extracted to work-state/parallel-workers.js. Re-imported here so all
// existing consumers of work-state.js are unaffected.
const _parallelWorkers = require('./work-state/parallel-workers');
const { allocateWorkerSlot, releaseWorkerSlot } = _parallelWorkers;

// Inject parent functions into submodules to break the circular dependency.
// MUST run before the CLI `main()` block below — `main()` is async but its
// first tick is synchronous and may call initTasksMeta before module.exports
// is assigned.
const _parentFns = { loadState, saveState, initState };
_taskReadiness._setParent(_parentFns);
_parallelWorkers._setParent(_parentFns);

if (require.main === module) {
  main().catch((err) => {
    if (_cliCommand === 'complete') {
      process.stderr.write(
        JSON.stringify({ error: `complete failed: ${err?.message || err}` }) + '\n'
      );
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
  initTasksMeta,
  validateTaskGraph,
  canStart,
  canStartFromState,
  getTaskCurrent,
  advanceTask,
  getTaskByIndex,
  getTaskReviewFixRounds,
  incrementTaskReviewFixRounds,
  resetTaskReviewFixRounds,
  // GH-219 Task 6: re-exports from work-claims.js
  claimTask,
  releaseTask,
  // GH-219 Task 7: PR{N} worker slot allocation
  allocateWorkerSlot,
  releaseWorkerSlot,
  STEPS,
  SUBTASK_STEPS,
  CHECK_AGENTS,
};
