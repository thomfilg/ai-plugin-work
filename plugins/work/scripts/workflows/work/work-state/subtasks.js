/**
 * Subtask state functions. Extracted verbatim from work-state.js (file-size
 * burndown) — behavior unchanged; shared primitives come from ./core.
 */

'use strict';

const { fs, path, TASKS_BASE, safeId, SUBTASK_STEPS } = require('./core');

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

  // Read directly and key off ENOENT rather than an existsSync precheck — the
  // check-then-read split is a TOCTOU race (CodeQL js/file-system-race). Error
  // messages are unchanged.
  let content, state;
  try {
    content = fs.readFileSync(statePath, 'utf8');
    state = JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Subtask state file not found: ${statePath}`);
    }
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

module.exports = {
  getNextSubtaskStatePath,
  initSubtaskState,
  loadActiveSubtaskState,
  completeSubtask,
};
