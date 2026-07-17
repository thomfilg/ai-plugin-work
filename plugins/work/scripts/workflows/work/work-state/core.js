/**
 * Work-state core: config bootstrap, shared constants, and the state-file IO
 * primitives (getStatePath / loadState / saveState / initState) plus the TDD
 * auto-init used across the work-state surface.
 *
 * Extracted from work-state.js (GH-219 file-size burndown). Behavior is
 * byte-for-byte the same as the former in-file definitions; the only structural
 * change is `autoInitTdd` delegating path resolution to a helper.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Load config.js, or exit(0) when it is unavailable (plugin not configured) —
// the same fail-open behavior the work-state CLI has always had. Wrapped in a
// function so the optional-require shape stays local to this module.
function requireConfigOrExit() {
  try {
    return require('../../lib/config');
  } catch (err) {
    if (err?.code === 'MODULE_NOT_FOUND' && err.message.includes('lib/config')) {
      process.exit(0);
    }
    throw err;
  }
}
const config = requireConfigOrExit();

const TASKS_BASE = config.TASKS_BASE;

const { ALL_STEPS: STEPS } = require(path.join(__dirname, '..', 'step-registry'));
const { taskSegment } = require('../../lib/allocate-output-folder');
const { stampVersionAnchor } = require('../lib/version-skew');

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
  stampVersionAnchor(state);

  return saveState(ticketId, state);
}

/**
 * Resolve + validate the tdd-phase.json path for a ticket (and optional task).
 * Returns an absolute path inside TASKS_BASE, or null when the ticketId is
 * unsafe or the resolved path escapes TASKS_BASE. Pure — performs no IO.
 * @param {string} ticketId
 * @param {number} [taskNum] - 1-indexed task number; per-task path when set
 * @returns {string|null}
 */
function resolveTddStatePath(ticketId, taskNum) {
  // Reject traversal chars before building the path.
  if (!ticketId || /\.\./.test(ticketId) || /\\/.test(ticketId)) return null;
  const tddStatePath =
    taskNum != null
      ? path.join(TASKS_BASE, safeId(ticketId), taskSegment(taskNum), 'tdd-phase.json')
      : path.join(TASKS_BASE, safeId(ticketId), 'tdd-phase.json');
  // Verify the resolved path stays within TASKS_BASE.
  if (!path.resolve(tddStatePath).startsWith(path.resolve(TASKS_BASE) + path.sep)) return null;
  return tddStatePath;
}

/**
 * Auto-initialize TDD phase state when entering the implement step.
 * Creates tdd-phase.json with RED phase so the developer agent is forced
 * to write tests first. Idempotent — skips if state already exists.
 * @param {string} ticketId
 * @param {number} [taskNum] - 1-indexed task number; when provided, writes to per-task path
 */
function autoInitTdd(ticketId, taskNum) {
  const tddStatePath = resolveTddStatePath(ticketId, taskNum);
  if (!tddStatePath) return;
  let fd;
  let created = false;
  try {
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

module.exports = {
  fs,
  path,
  config,
  TASKS_BASE,
  STEPS,
  SUBTASK_STEPS,
  CHECK_AGENTS,
  safeId,
  taskSegment,
  getStatePath,
  loadState,
  saveState,
  initState,
  autoInitTdd,
};
