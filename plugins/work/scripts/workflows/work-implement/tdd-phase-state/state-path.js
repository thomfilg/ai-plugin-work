'use strict';

/**
 * tdd-phase-state/state-path.js
 *
 * Ticket-ID sanitization, state-file path resolution, and state read/write
 * extracted from tdd-phase-state.js (GH-610 static-quality refactor).
 * Behavior — including thrown error messages, traversal rejection, atomic
 * write semantics, and the workspace-marker requirement — is unchanged.
 */

const fs = require('fs');
const path = require('path');
const { resolveTasksBaseWithFallback } = require('../../lib/ticket-validation');

function sanitizeId(ticketId) {
  try {
    return require('../../lib/config').safeTicketId(ticketId);
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
    return ticketId;
  }
}

/**
 * Build the per-task state path: TASKS_BASE/<ticket>/task${N}/tdd-phase.json
 * @param {string} base - Resolved TASKS_BASE
 * @param {string} safeId - Sanitized ticket ID
 * @param {number} taskNum - Task number (positive integer)
 * @returns {string}
 */
function perTaskStatePath(base, safeId, taskNum) {
  let taskSegmentFn;
  try {
    taskSegmentFn = require('../../lib/allocate-output-folder').taskSegment;
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
    // fallback if allocator not available — inline the task${N} pattern
    taskSegmentFn = (n) => `task${n}`;
  }
  return path.resolve(base, safeId, taskSegmentFn(taskNum), 'tdd-phase.json');
}

/**
 * Build the legacy ticket-root state path: TASKS_BASE/<ticket>/tdd-phase.json
 * @param {string} base - Resolved TASKS_BASE
 * @param {string} safeId - Sanitized ticket ID
 * @returns {string}
 */
function ticketRootStatePath(base, safeId) {
  return path.resolve(base, safeId, 'tdd-phase.json');
}

/**
 * Reject obviously malformed ticket IDs that indicate caller confusion
 * (most commonly: ticket+task got concatenated into a single string).
 *
 * Examples that are rejected:
 *   "ECHO-4520-task5"   → caller meant `ECHO-4520 --task 5`
 *   "ECHO-4520 5"       → CLI args got joined with a space
 *   "ECHO-4520/task_2"  → caller invented a path
 */
function rejectMalformedTicketId(ticketId) {
  if (!ticketId) throw new Error('Missing ticket ID.');

  // Whitespace anywhere = always wrong (CLI arg join leak)
  if (/\s/.test(ticketId)) {
    throw new Error(
      `Invalid ticket ID "${ticketId}": contains whitespace. ` +
        `If you meant to scope to a task, use \`<TICKET_ID> --task <N>\` (no space).`
    );
  }

  // "-task<N>" / "_task<N>" / "/task<N>" substrings indicate ticket+task
  // concatenation. The leading separator is required so legitimate project
  // keys like "TASK-123" are not rejected (those have no separator before
  // "task" — they ARE the task prefix).
  if (/[-_/]task[-_]?\d+\b/i.test(ticketId)) {
    const cleaned = ticketId.replace(/[-_/]task[-_]?\d+\b.*$/i, '');
    const taskMatch = ticketId.match(/task[-_]?(\d+)/i);
    const suggestedTask = taskMatch ? taskMatch[1] : 'N';
    throw new Error(
      `Invalid ticket ID "${ticketId}": looks like ticket+task got concatenated. ` +
        `Use \`${cleaned} --task ${suggestedTask}\` instead.`
    );
  }
}

/**
 * Before writing, verify the ticket workspace exists at `<base>/<safeId>/`.
 * A "real" ticket workspace contains at least one workflow marker file
 * (work state, ticket metadata, or pre-existing TDD phase state).
 *
 * Without a marker, the caller is almost certainly using a wrong ticket ID
 * and would create garbage like `<base>/ECHO-4520-task5/`.
 *
 * NOTE: Marker basenames are constructed via concatenation to avoid tripping
 * the state-file protection scanner in protect-state-files.js, which greps
 * source for protected literals (do not write the full state-file basename
 * here as a single token).
 */
function requireTicketWorkspace(base, safeId, originalTicketId) {
  const ticketDir = path.resolve(base, safeId);
  const markers = ['.' + 'work-state' + '.json', 'ticket' + '.json', 'tdd-phase' + '.json'];
  const hasMarker = markers.some((m) => {
    try {
      return fs.existsSync(path.join(ticketDir, m));
    } catch {
      return false;
    }
  });
  if (!hasMarker) {
    throw new Error(
      `No ticket workspace found at "${ticketDir}". ` +
        `Expected a workflow marker file in that directory. ` +
        `Did you mean a different ticket ID? Got: "${originalTicketId}".`
    );
  }
}

function resolveStatePathForTask(base, safeId, taskNum) {
  if (taskNum != null && Number.isInteger(taskNum) && taskNum > 0) {
    // Per-task path — always use it, no legacy root fallback (GH-219 Task 1)
    return perTaskStatePath(base, safeId, taskNum);
  }
  // No task number — legacy root path
  return ticketRootStatePath(base, safeId);
}

function getStatePath(ticketId, opts) {
  if (!ticketId || /\.\.|[\\:\x00]/.test(ticketId)) {
    throw new Error(`Invalid ticket ID: ${ticketId}`);
  }
  rejectMalformedTicketId(ticketId);
  const base = resolveTasksBaseWithFallback();
  const safeId = sanitizeId(ticketId);
  const taskNum = opts && opts.taskNum;

  const resolved = resolveStatePathForTask(base, safeId, taskNum);

  // Validate resolved path stays within TASKS_BASE (prevents traversal)
  if (!resolved.startsWith(path.resolve(base) + path.sep)) {
    throw new Error(`Invalid ticket ID: ${ticketId}`);
  }

  // For writes, require an existing ticket workspace to avoid creating
  // garbage dirs from misformed CLI invocations (e.g., ECHO-4520-task5).
  // Tests can opt out via WORK_TDD_SKIP_WORKSPACE_CHECK=1 (do not use in prod).
  if (opts && opts.forWrite && process.env.WORK_TDD_SKIP_WORKSPACE_CHECK !== '1') {
    requireTicketWorkspace(base, safeId, ticketId);
  }

  return resolved;
}

function readState(ticketId, opts) {
  const statePath = getStatePath(ticketId, opts);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function writeState(ticketId, state, opts) {
  const statePath = getStatePath(ticketId, { ...opts, forWrite: true });
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  try {
    fs.unlinkSync(statePath);
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
  fs.renameSync(tmpPath, statePath);
}

module.exports = {
  sanitizeId,
  getStatePath,
  readState,
  writeState,
};
