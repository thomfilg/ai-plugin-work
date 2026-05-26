/**
 * work-helpers.js
 *
 * Shared synchronous helpers used by the work orchestrator: shell exec,
 * filesystem probes, and work-state (.work-state.json) load/save.
 *
 * All functions are pure with respect to their inputs and do not import
 * configuration — callers pass in TASKS_BASE explicitly.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Executes a shell command synchronously. Returns stdout on success, '' on any error.
 */
function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    }).trim();
  } catch {
    return '';
  }
}

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Lists files in `dir` matching a string substring or RegExp pattern.
 * Returns absolute paths. Returns [] if dir does not exist or is unreadable.
 */
function listFiles(dir, pattern) {
  if (!fileExists(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => (pattern instanceof RegExp ? pattern.test(f) : f.includes(pattern)))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Loads .work-state.json for a ticket. Returns null if missing or unparseable. */
function loadWorkState(tasksBase, ticket) {
  const p = path.join(tasksBase, ticket, '.work-state.json');
  if (!fileExists(p)) return null;
  try {
    return JSON.parse(readFile(p));
  } catch {
    return null;
  }
}

/** Persists state to .work-state.json, creating the directory if needed. */
function saveWorkState(tasksBase, ticket, state) {
  const dir = path.join(tasksBase, ticket);
  if (!fileExists(dir)) fs.mkdirSync(dir, { recursive: true });
  state.lastUpdate = new Date().toISOString();
  fs.writeFileSync(path.join(dir, '.work-state.json'), JSON.stringify(state, null, 2));
  return state;
}

/**
 * Determines the current step from a work-state object using the step registry.
 * Returns STEPS.ticket if no state, STEPS.complete if all steps completed.
 */
function getCurrentStep(workState, STEPS, ALL_STEPS) {
  if (!workState?.stepStatus) return STEPS.ticket;
  for (const step of ALL_STEPS) {
    if (workState.stepStatus[step] === 'in_progress') return step;
  }
  for (const step of ALL_STEPS) {
    if (workState.stepStatus[step] !== 'completed') return step;
  }
  return STEPS.complete;
}

module.exports = {
  run,
  fileExists,
  readFile,
  listFiles,
  loadWorkState,
  saveWorkState,
  getCurrentStep,
};
