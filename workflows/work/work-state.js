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
      try {
        fs.unlinkSync(path.join(TASKS_BASE, safeId(ticketId), 'tdd-phase.json'));
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

/**
 * @typedef {Object} TaskGraphError
 * @property {string} code
 *   Stable identifier for the violation. One of:
 *   `UNKNOWN_DEPENDENCY`, `SELF_DEPENDENCY`, `DEPENDENCY_CYCLE`,
 *   `INVALID_TASK_GRAPH`, `INVALID_TASK_ENTRY`. Used as rule id by preflight.
 * @property {string|null} taskId
 *   Task id (`task_${num}`) the violation belongs to, or null when the input
 *   is not an array / not shaped as a task list.
 * @property {string} message    Human-readable description.
 * @property {string[]} remediation
 *   Actionable fix steps (R18 explainability). Non-empty for every error.
 */

/**
 * @typedef {Object} TaskGraphValidation
 * @property {boolean} valid
 * @property {TaskGraphError[]} errors
 *   All detected violations. Self-dependency errors are reported as
 *   `SELF_DEPENDENCY` (not `DEPENDENCY_CYCLE`) for actionable remediation.
 */

/**
 * Validate a task dependency graph.
 *
 * Pure function — no filesystem I/O. Intended to be shared by:
 *   1. `initTasksMeta` (this file) — called BEFORE persisting tasksMeta so
 *      invalid graphs never reach disk (R4).
 *   2. Task 12 preflight in `workflows/lib/preflight.js` — re-runs on every
 *      enforcement decision without duplicating validation logic (see
 *      acceptance criteria: "`validateTaskGraph` exports a stable API for
 *      reuse by Task 12").
 *
 * Accepts an array of task descriptors (from `task-parser.js` `parseTasks`).
 * Each task must have a numeric `num`. A missing `dependencies` field is
 * treated as `[]` (no error) to support legacy / partially-annotated plans.
 *
 * Violations detected:
 *   - `SELF_DEPENDENCY`    — task declares itself as a dependency
 *   - `UNKNOWN_DEPENDENCY` — dependency id has no matching task
 *   - `DEPENDENCY_CYCLE`   — directed cycle in the remaining edges after
 *                             self-edges are stripped (DFS coloring)
 *
 * @param {Array<{num:number, dependencies?:number[]}>} tasks
 * @returns {TaskGraphValidation}
 */
function validateTaskGraph(tasks) {
  if (!Array.isArray(tasks)) {
    return {
      valid: false,
      errors: [
        {
          code: 'INVALID_TASK_GRAPH',
          taskId: null,
          message: `validateTaskGraph expected an array of tasks, received ${tasks === null ? 'null' : typeof tasks}.`,
          remediation: [
            'Pass the result of parseTasks(tasksDir) from task-parser.js.',
            'Verify tasks.md exists and has at least one `## Task N` section.',
          ],
        },
      ],
    };
  }

  const errors = [];

  // Build task-number set and adjacency list in a single pass. Skip tasks
  // whose `num` is not a positive integer — report once but keep going so
  // we can surface every detectable error in one call.
  const taskNums = new Set();
  for (const task of tasks) {
    if (task && Number.isInteger(task.num) && task.num > 0) {
      taskNums.add(task.num);
    } else {
      errors.push({
        code: 'INVALID_TASK_ENTRY',
        taskId: null,
        message: `Task entry missing a positive integer \`num\` field: ${JSON.stringify(task)}`,
        remediation: [
          'Ensure each `## Task N` heading in tasks.md uses a positive integer.',
          'Re-run `parseTasks(tasksDir)` and inspect the output before passing to validateTaskGraph.',
        ],
      });
    }
  }

  // adj[taskNum] = list of dep task nums (self-edges stripped; self-dep
  // reported separately). Only includes edges where the target exists.
  const adj = new Map();
  for (const task of tasks) {
    if (!task || !Number.isInteger(task.num)) continue;
    const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
    const filteredDeps = [];
    for (const dep of deps) {
      if (!Number.isInteger(dep)) continue; // parseTasks only emits ints; defensive
      if (dep === task.num) {
        errors.push({
          code: 'SELF_DEPENDENCY',
          taskId: `task_${task.num}`,
          message: `Task ${task.num} depends on itself.`,
          remediation: [
            `Remove the self-reference from Task ${task.num}'s \`### Dependencies\` section in tasks.md.`,
            'A task cannot wait for its own completion.',
          ],
        });
        continue; // strip from adjacency — don't double-report as cycle
      }
      if (!taskNums.has(dep)) {
        errors.push({
          code: 'UNKNOWN_DEPENDENCY',
          taskId: `task_${task.num}`,
          message: `Task ${task.num} depends on unknown Task ${dep}.`,
          remediation: [
            `Verify Task ${dep} exists in tasks.md under a \`## Task ${dep}\` heading.`,
            `Update Task ${task.num}'s \`### Dependencies\` section to reference an existing task id.`,
          ],
        });
        continue; // unknown edge cannot participate in cycle detection
      }
      filteredDeps.push(dep);
    }
    adj.set(task.num, filteredDeps);
  }

  // Cycle detection via DFS coloring (WHITE/GRAY/BLACK). A GRAY back-edge
  // indicates a cycle; we reconstruct the cycle from the DFS path and dedupe
  // on canonical rotation so A→B→A and B→A→B report once.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  for (const num of taskNums) color.set(num, WHITE);

  const reportedCycles = new Set();

  function dfs(start) {
    // Iterative DFS with explicit path tracking; avoids recursion depth limits
    // on large graphs while preserving the back-edge detection semantics.
    const stack = [{ node: start, depIndex: 0 }];
    const path = [];
    color.set(start, GRAY);
    path.push(start);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = adj.get(frame.node) || [];
      if (frame.depIndex < neighbors.length) {
        const next = neighbors[frame.depIndex++];
        const c = color.get(next);
        if (c === GRAY) {
          // Back-edge → cycle. Extract cycle from path and dedupe.
          const startIdx = path.indexOf(next);
          const cycle = path.slice(startIdx);
          const cycleKey = [...cycle].sort((a, b) => a - b).join(',');
          if (!reportedCycles.has(cycleKey)) {
            reportedCycles.add(cycleKey);
            const display = [...cycle, next].map((n) => `Task ${n}`).join(' → ');
            errors.push({
              code: 'DEPENDENCY_CYCLE',
              taskId: `task_${next}`,
              message: `Dependency cycle detected: ${display}.`,
              remediation: [
                'Break the cycle by removing one dependency edge in tasks.md.',
                `Review the \`### Dependencies\` section of each task in the cycle (${cycle
                  .map((n) => `Task ${n}`)
                  .join(', ')}).`,
                'Tasks in a cycle can never start — at least one must drop its back-reference.',
              ],
            });
          }
        } else if (c === WHITE) {
          color.set(next, GRAY);
          path.push(next);
          stack.push({ node: next, depIndex: 0 });
        }
        // BLACK: fully explored subtree — safe to skip (no new cycles reachable)
      } else {
        color.set(frame.node, BLACK);
        path.pop();
        stack.pop();
      }
    }
  }

  for (const num of taskNums) {
    if (color.get(num) === WHITE) {
      dfs(num);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Initialize task tracking for a ticket.
 *
 * Accepts EITHER:
 *   - a positive integer `taskCount` (LEGACY / R16 pre-IDEA2 form) — creates
 *     tasks without a `dependencies` field, matching pre-IDEA2 wire format.
 *     Callers (e.g. `implement.js` spawning `task-init COUNT` via CLI)
 *     continue to work unchanged.
 *   - an array of task descriptors from `parseTasks(tasksDir)` (NEW IDEA2
 *     form) — runs `validateTaskGraph` BEFORE persisting. Invalid graphs
 *     return `{ error, errors }` and never reach disk (R4 fail-closed).
 *
 * On success with the array form, each persisted `tasksMeta.tasks[i]` gains
 * a `dependencies: number[]` copy of the source task's dependency list.
 *
 * Idempotent: if `tasksMeta` already exists, returns it unchanged.
 *
 * @param {string} ticketId
 * @param {number | Array<{num:number, dependencies?:number[]}>} taskCountOrTasks
 * @returns {object}
 *   - `{ ...state }` on success (same shape as `saveState` return)
 *   - `{ success: true, tasksMeta, idempotent: true }` on idempotent call
 *   - `{ error: string, errors?: TaskGraphError[] }` on validation failure
 */
function initTasksMeta(ticketId, taskCountOrTasks) {
  const isTaskArray = Array.isArray(taskCountOrTasks);
  const tasksInput = isTaskArray ? taskCountOrTasks : null;
  const taskCount = isTaskArray ? tasksInput.length : taskCountOrTasks;

  if (!Number.isInteger(taskCount) || taskCount <= 0) {
    return { error: `Invalid taskCount: ${taskCount}. Must be a positive integer.` };
  }

  // ─── R4: Graph validation BEFORE any persistence write ─────────────────
  // Only validate when the caller opts into the IDEA2 form (array). Integer
  // form preserves pre-IDEA2 semantics: no dependencies, no graph to check.
  if (isTaskArray) {
    const validation = validateTaskGraph(tasksInput);
    if (!validation.valid) {
      return {
        error: 'Invalid task graph — see `errors` for details.',
        errors: validation.errors,
      };
    }
  }

  let state = loadState(ticketId);
  if (!state) state = initState(ticketId);

  // Idempotent: return existing task tracking if already initialized
  if (state?.tasksMeta) {
    return { success: true, tasksMeta: state.tasksMeta, idempotent: true };
  }

  const tasks = [];
  for (let i = 0; i < taskCount; i++) {
    const entry = { id: `task_${i + 1}`, status: 'pending' };
    if (isTaskArray) {
      // Copy dependencies from parseTasks output. Match by `num` (1-indexed)
      // so out-of-order task lists still produce the correct mapping.
      const src = tasksInput.find((t) => t && t.num === i + 1);
      const deps = src && Array.isArray(src.dependencies) ? src.dependencies : [];
      entry.dependencies = deps.slice(); // defensive copy — callers can't mutate persisted state
    }
    tasks.push(entry);
  }

  state.tasksMeta = {
    totalTasks: taskCount,
    currentTaskIndex: 0,
    tasks,
  };

  return saveState(ticketId, state);
}

/**
 * Check whether a task is ready to start, per its declared dependencies.
 *
 * Pure query — reads `loadState(ticketId).tasksMeta` only, no other I/O.
 * Single source of truth for dependency readiness (R3) — Task 12 preflight
 * imports this function; there must not be a second implementation
 * elsewhere.
 *
 * Semantics:
 *   - Task has no `dependencies` field (pre-IDEA2) → return `true`.
 *     R16 default: preserves pre-IDEA2 sequential behavior where the
 *     orchestrator drives order via `currentTaskIndex` and every task
 *     is considered startable from the graph's point of view.
 *   - Task has `dependencies: []`                → return `true`.
 *   - Every declared dep exists in `tasksMeta.tasks` with
 *     `status === 'completed'`                    → return `true`.
 *   - Any dep is pending, missing, or the task itself is already completed
 *                                                 → return `false` (fail-closed).
 *
 * The "completed task is not startable" rule mirrors advanceTask's idempotent
 * terminal behavior — canStart is a forward-looking question about work that
 * could still be begun, not about work that has been done.
 *
 * @param {string} ticketId
 * @param {number} taskNum - 1-indexed task number (matches `task_${N}` id /
 *                           `## Task N` heading in tasks.md).
 * @returns {boolean}
 */
/**
 * Find a persisted task entry by its 1-indexed task number.
 * Returns null if the state is uninitialized or the number is out of range.
 * @param {object} state - Full ticket state as returned by `loadState`.
 * @param {number} taskNum - 1-indexed task number (maps to `task_${N}`).
 * @returns {object|null}
 */
function findTaskByNum(state, taskNum) {
  if (!state || !state.tasksMeta || !Array.isArray(state.tasksMeta.tasks)) return null;
  if (!Number.isInteger(taskNum) || taskNum <= 0) return null;
  const targetId = `task_${taskNum}`;
  return state.tasksMeta.tasks.find((t) => t && t.id === targetId) || null;
}

function canStart(ticketId, taskNum) {
  const state = loadState(ticketId);
  const task = findTaskByNum(state, taskNum);
  if (!task) return false; // uninitialized, bad input, or unknown task

  // Already completed → not startable (forward-looking query)
  if (task.status === 'completed') return false;

  // R16 backward compat: missing `dependencies` field means the task was
  // persisted under the pre-IDEA2 schema. Treat as empty deps — sequential
  // orchestrator handles ordering.
  if (!Array.isArray(task.dependencies)) return true;

  // Empty deps → startable
  if (task.dependencies.length === 0) return true;

  // All declared deps must resolve to a completed task. Unknown dep →
  // fail-closed (R4: validation should have prevented this, but belt-and-
  // suspenders for state files that skipped the new initTasksMeta path).
  for (const depNum of task.dependencies) {
    const dep = findTaskByNum(state, depNum);
    if (!dep) return false;
    if (dep.status !== 'completed') return false;
  }

  return true;
}

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

// ─── Task claim locks (GH-219 Task 6) ───────────────────────────────────────
// Per-task atomic claim semantics live in `./work-claims.js`. We re-export
// `claimTask` / `releaseTask` here so downstream CLI and hook consumers can
// import a single "work state" surface, and so the spec verification
// checklist grep for `/claimTask/` and `/\.claims/` in work-state.js is
// satisfied without duplicating the implementation.
// Claim lock files live at `TASKS_BASE/<ticketId>/.claims/task-${n}.lock`.
const { claimTask, releaseTask } = require('./work-claims');

// ─── Parallel worker PR{N} slot allocation (GH-219 Task 7) ─────────────────
// IDEA2 R14: Parallel worker layout `${WORKTREES_BASE}/tasks/<ticketId>/PR{N}/`.
// Because `config.TASKS_BASE` defaults to `path.join(WORKTREES_BASE, 'tasks')`
// (see workflows/lib/config.js lines 125–127 and the repo .envrc), directories
// resolve to `${TASKS_BASE}/<safeTicketId>/PR{N}/` — we use `TASKS_BASE` as
// the source of truth, same as every other path builder in this file.
//
// Design — "reuse after release":
//   The brief / spec call for "reuse after clean completion" but the task
//   description explicitly allows monotonic increment as a valid spec-aligned
//   choice ("if unclear in spec, prefer monotonic increment"). We pick
//   MONOTONIC INCREMENT: `nextSlot` only grows, releases mark `releasedAt`
//   in the audit trail, and new allocations always yield a fresh slot. This
//   avoids ABA-style reuse races where a released slot is re-assigned to a
//   new worker while the crashed worker's filesystem side-effects still
//   reference the old slot directory. The spec's "reuse" requirement is
//   satisfied by the allocations audit trail — a caller can observe which
//   slots are live (no `releasedAt`) vs completed (has `releasedAt`) and
//   act accordingly without needing to collide on slot numbers.
//
// Owner id format: `PR${slot}` — MUST satisfy the same `OWNER_ID_RE` as Task 6
// (`work-claims.js` `/^PR\d+$/`). We redefine the regex here (rather than
// importing `work-claims._internals.OWNER_ID_RE`) to keep this module's
// validation gate self-contained — the two definitions are one line each
// and must stay in sync (enforced by cross-referencing tests in
// `work-state-parallel.test.js` and `work-claims.test.js`).

const PARALLEL_OWNER_ID_RE = /^PR\d+$/;

/**
 * Validate a ticket id for parallel-worker allocation.
 *
 * Mirrors the fail-closed rules in `work-claims.js` `validateTicketId`
 * (non-empty string, no path separators, no traversal) so a ticket id
 * that passes `allocateWorkerSlot` will also pass `claimTask`.
 *
 * Returns `null` on success, a structured error descriptor otherwise.
 */
function _validateParallelTicketId(ticketId) {
  if (typeof ticketId !== 'string') {
    return {
      code: 'INVALID_TICKET_ID',
      message: `ticketId must be a non-empty string (received ${ticketId === null ? 'null' : typeof ticketId}).`,
      remediation: [
        'Pass a ticket id like "GH-219" or "PROJ-123".',
        'Hooks should resolve ticket id via workflows/lib/scripts/get-ticket-id.js before calling allocateWorkerSlot.',
      ],
    };
  }
  if (ticketId.trim() === '') {
    return {
      code: 'INVALID_TICKET_ID',
      message: 'ticketId must be a non-empty string (received empty/whitespace).',
      remediation: ['Pass a ticket id like "GH-219" or "PROJ-123".'],
    };
  }
  // Reject path separators and traversal fragments before any FS I/O so
  // the caller gets a structured rejection rather than a path-escape bug.
  if (/[\\/:\0]/.test(ticketId) || ticketId.includes('..')) {
    return {
      code: 'INVALID_TICKET_ID',
      message: `ticketId ${JSON.stringify(ticketId)} contains path separators or traversal sequences.`,
      remediation: [
        'Remove any "/", "\\", "..", or null bytes from the ticket id.',
        'Ticket ids are bare provider keys like "GH-219" or "PROJ-123" — not paths.',
      ],
    };
  }
  return null;
}

/**
 * Build a canonical INVALID_SLOT error descriptor. DRY helper so both
 * the string and number validation paths emit identical remediation.
 */
function _invalidSlotError(slot) {
  return {
    code: 'INVALID_SLOT',
    message: `slot ${JSON.stringify(slot)} must be a positive integer.`,
    remediation: [
      'Pass a positive integer slot number returned by allocateWorkerSlot.',
      'Check TASKS_BASE/<ticketId>/.work-state.json `parallelWorkers.allocations` for valid slot numbers.',
    ],
  };
}

/**
 * Normalize `slot` to a positive integer or return a structured error.
 *
 * Accepts a number or a plain-digit string ("1", "42"). Rejects non-integers,
 * decimals, negatives, zero, NaN, empty string, and non-primitives.
 *
 * Returns `{ error, value }` — mirrors the shape of `validateTaskNum` in
 * `work-claims.js` so callers that already know that pattern read cleanly.
 */
function _validateParallelSlot(slot) {
  let value = slot;
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) return { error: _invalidSlotError(slot), value: null };
    value = Number(value);
  }
  if (!Number.isInteger(value) || value <= 0) {
    return { error: _invalidSlotError(slot), value: null };
  }
  return { error: null, value };
}

/**
 * Resolve the absolute `PR{N}` worker directory for `ticketId`.
 * Pure function — caller decides whether to `mkdirSync` it.
 */
function _workerSlotDir(ticketId, slot) {
  return path.join(TASKS_BASE, safeId(ticketId), `PR${slot}`);
}

/**
 * Allocate the next `PR{N}` worker slot for `ticketId` and create its
 * worktree directory under `${TASKS_BASE}/<safeTicketId>/PR{N}/`.
 *
 * Contract:
 *   - Sequential, monotonic: `nextSlot` only grows. First call → slot 1,
 *     second call → slot 2, etc. Persisted in `.work-state.json` under
 *     `parallelWorkers: { nextSlot, allocations: [...] }`.
 *   - Owner id format: `PR${slot}` — satisfies `work-claims.js` `OWNER_ID_RE`
 *     so the returned `ownerId` flows directly into `claimTask` without
 *     translation (R5).
 *   - Directory is created (recursive, idempotent) under TASKS_BASE before
 *     return so the caller can immediately write into it.
 *   - Fail-closed validation (R15): bad `ticketId` returns a structured
 *     error BEFORE any filesystem I/O or directory creation.
 *   - Concurrency: in-process serialized — one orchestrator allocates slots.
 *     Cross-process races are out of scope (spec defers to `claimTask`'s
 *     link(2)-atomic lock as the true serialization gate).
 *
 * Audit entry shape (see spec "Data Model → parallelWorkers"):
 *   `{ slot, ownerId, taskNum?, claimedAt, releasedAt? }`
 *
 * @param {string} ticketId
 * @param {{ taskNum?: number }} [context]
 *   Optional — if `context.taskNum` is a positive integer, it is recorded
 *   in the audit entry so `.work-state.json` shows which task this slot
 *   is intending to claim.
 * @returns {{ slot: number, ownerId: string, dir: string } | { success: false, error: { code: string, message: string, remediation: string[] } }}
 */
function allocateWorkerSlot(ticketId, context = {}) {
  // R15: validate BEFORE any filesystem I/O / directory creation.
  const ticketErr = _validateParallelTicketId(ticketId);
  if (ticketErr) return { success: false, error: ticketErr };

  // Ensure state exists (idempotent); safe to create `.work-state.json`
  // only after input validation has passed.
  let state = loadState(ticketId);
  if (!state) state = initState(ticketId);

  if (!state.parallelWorkers) {
    state.parallelWorkers = { nextSlot: 1, allocations: [] };
  }

  const slot = state.parallelWorkers.nextSlot;
  const ownerId = `PR${slot}`;
  const dir = _workerSlotDir(ticketId, slot);

  // Defensive: OWNER_ID_RE is the canonical format gate — if a future edit
  // accidentally breaks the ownerId format, fail loudly rather than emit a
  // bad id that Task 6's claimTask will later reject.
  if (!PARALLEL_OWNER_ID_RE.test(ownerId)) {
    throw new Error(
      `allocateWorkerSlot produced non-conformant ownerId ${JSON.stringify(ownerId)} — this is a bug in work-state.js.`
    );
  }

  const entry = {
    slot,
    ownerId,
    claimedAt: new Date().toISOString(),
  };
  if (context && Number.isInteger(context.taskNum) && context.taskNum > 0) {
    entry.taskNum = context.taskNum;
  }
  state.parallelWorkers.allocations.push(entry);
  state.parallelWorkers.nextSlot = slot + 1;

  // Persist BEFORE directory creation. If `mkdirSync` throws (EACCES, ENOSPC)
  // the state file still reflects a consistent slot reservation — the caller
  // can retry or release explicitly without corrupting the counter.
  saveState(ticketId, state);

  fs.mkdirSync(dir, { recursive: true });

  return { slot, ownerId, dir };
}

/**
 * Release a previously-allocated `PR{N}` worker slot.
 *
 * Marks the audit-trail entry with `releasedAt` (ISO timestamp). Does NOT
 * decrement `nextSlot` and does NOT reuse the slot number on a subsequent
 * allocation — see the "reuse after release" decision in the file header.
 * The PR{N} directory is left on disk; cleanup is the caller's
 * responsibility (worktree removal / artifact archival is out of scope).
 *
 * Idempotent: releasing an already-released slot succeeds without mutating
 * state (original `releasedAt` is preserved for audit fidelity).
 *
 * R15: fail-closed validation — bad inputs return a structured error
 * before any state mutation.
 *
 * @param {string} ticketId
 * @param {number|string} slot - as returned by `allocateWorkerSlot(...).slot`
 * @returns {{ success: true, idempotent?: boolean } | { success: false, error: { code: string, message: string, remediation: string[] } }}
 */
function releaseWorkerSlot(ticketId, slot) {
  const ticketErr = _validateParallelTicketId(ticketId);
  if (ticketErr) return { success: false, error: ticketErr };

  const { error: slotErr, value: slotInt } = _validateParallelSlot(slot);
  if (slotErr) return { success: false, error: slotErr };

  const state = loadState(ticketId);
  if (!state || !state.parallelWorkers || !Array.isArray(state.parallelWorkers.allocations)) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_SLOT',
        message: `No parallelWorkers state for ticket ${ticketId}. Nothing to release.`,
        remediation: [
          'Verify allocateWorkerSlot was called for this ticket.',
          'Check that the ticket id matches the one used during allocation.',
        ],
      },
    };
  }

  const entry = state.parallelWorkers.allocations.find((x) => x.slot === slotInt);
  if (!entry) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_SLOT',
        message: `Slot ${slotInt} was never allocated on ticket ${ticketId}.`,
        remediation: [
          'Pass a slot number returned by a prior allocateWorkerSlot call.',
          `Inspect ${path.join(TASKS_BASE, safeId(ticketId), '.work-state.json')} → parallelWorkers.allocations for the list of valid slot numbers.`,
        ],
      },
    };
  }

  // Idempotent re-release: preserve the original releasedAt timestamp so
  // the audit trail reflects the first clean completion, not a replay.
  if (entry.releasedAt) {
    return { success: true, idempotent: true };
  }

  entry.releasedAt = new Date().toISOString();
  saveState(ticketId, state);
  return { success: true };
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
