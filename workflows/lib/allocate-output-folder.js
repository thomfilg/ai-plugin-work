/**
 * allocate-output-folder.js
 *
 * Central allocator for /work-implement destination resolution (GH-219 Task 9).
 *
 * Given a ticket ID and context, returns the correct absolute base directory:
 *
 *   - In-flow (workflow origin, claimed task): TASKS_BASE/<ticketId>/task${N}/
 *   - Out-of-flow user:  TASKS_BASE/<ticketId>/user-request-${k}/  (stub -- Task 10 wires counters)
 *   - Out-of-flow AI:    TASKS_BASE/<ticketId>/ai-request-${k}/    (stub -- Task 10 wires counters)
 *   - Legacy-root:       TASKS_BASE/<ticketId>/                     (backward-compat fallback)
 *
 * R7 single source of truth: the `task${N}` naming is produced exclusively by
 * taskSegment(). Other modules must consume this rather than rebuilding the
 * segment string.
 *
 * @module allocate-output-folder
 */

const path = require('path');

// ─── Constants (R7 naming policy) ────────────────────────────────────────────

const TASK_SEGMENT_PREFIX = 'task';
const USER_REQUEST_PREFIX = 'user-request-';
const AI_REQUEST_PREFIX = 'ai-request-';

// ─── Ticket ID validation (R15 fail-closed) ─────────────────────────────────

/** @type {RegExp} Reject path-traversal sequences, backslashes, and null bytes */
const UNSAFE_TICKET_RE = /\.\.|[\\]|\x00/;

/**
 * Validate and reject unsafe ticket IDs before any filesystem I/O.
 * @param {unknown} ticketId
 */
function validateTicketId(ticketId) {
  if (typeof ticketId !== 'string' || ticketId.length === 0) {
    throw new Error(
      `Invalid ticket ID: expected non-empty string, received ${typeof ticketId === 'string' ? '""' : typeof ticketId}`
    );
  }
  if (UNSAFE_TICKET_RE.test(ticketId)) {
    throw new Error(
      `Invalid ticket ID: contains unsafe characters (path traversal, backslash, or null byte): "${ticketId}"`
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve TASKS_BASE from environment or config module.
 * @returns {string}
 */
function resolveTasksBase() {
  // Check process.env directly — callers (hooks, CLI) always set TASKS_BASE.
  // Do not fall back to config cache: config.TASKS_BASE is set at module-load
  // time and becomes stale if the env var is later removed (e.g., in tests).
  if (process.env.TASKS_BASE) return process.env.TASKS_BASE;

  throw new Error(
    'TASKS_BASE is not configured. Set the TASKS_BASE environment variable.'
  );
}

/**
 * Sanitize ticket ID for filesystem paths using config.safeTicketId when available.
 * @param {string} ticketId
 * @returns {string}
 */
function sanitizeId(ticketId) {
  try {
    const config = require('./config');
    if (config && typeof config.safeTicketId === 'function') {
      return config.safeTicketId(ticketId);
    }
  } catch {
    // fallback to raw ID
  }
  return ticketId;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Produce the canonical `task${N}` segment name (R7 single source of truth).
 *
 * @param {number} taskNum - Positive integer task number
 * @returns {string} e.g. "task1", "task9", "task42"
 * @throws {Error} if taskNum is not a positive integer
 */
function taskSegment(taskNum) {
  if (
    typeof taskNum !== 'number' ||
    !Number.isInteger(taskNum) ||
    taskNum < 1
  ) {
    throw new Error(
      `Invalid taskNum: expected positive integer, received ${JSON.stringify(taskNum)}`
    );
  }
  return `${TASK_SEGMENT_PREFIX}${taskNum}`;
}

/**
 * @typedef {Object} AllocationResult
 * @property {'in-flow-task'|'out-of-flow-user'|'out-of-flow-ai'|'legacy-root'} kind
 * @property {string|null} segment - Directory segment name (e.g. "task9", "user-request-4"), or null for legacy-root
 * @property {string} root - Absolute path to the allocated directory
 * @property {string} ticketRoot - Absolute path to the ticket-level directory
 */

/**
 * Allocate the correct output folder for a /work-implement invocation.
 *
 * @param {string} ticketId - Ticket ID (e.g. "GH-219")
 * @param {object} [context={}] - Allocation context
 * @param {string} [context.origin] - Origin type: "workflow", "ai-subtask", "user"
 * @param {string} [context.flow] - Flow type: "in-flow", "out-of-flow"
 * @param {number} [context.taskNum] - Task number (required for in-flow)
 * @param {number} [context.prSlot] - PR slot number (informational)
 * @param {number} [context.subtaskIndex] - Subtask index
 * @param {object} [context.counters] - Out-of-flow counters (Task 10 wires these)
 * @param {number} [context.counters.userRequestNext] - Next user-request counter
 * @param {number} [context.counters.aiRequestNext] - Next ai-request counter
 * @returns {AllocationResult}
 */
function allocateOutputFolder(ticketId, context = {}) {
  // R15: validate ticket ID before any I/O
  validateTicketId(ticketId);

  const tasksBase = resolveTasksBase();
  const safeId = sanitizeId(ticketId);
  const ticketRoot = path.join(tasksBase, safeId);
  // Defense-in-depth: ensure ticket root stays under TASKS_BASE
  const resolvedRoot = path.resolve(ticketRoot);
  const resolvedBase = path.resolve(tasksBase);
  if (resolvedRoot !== resolvedBase && !resolvedRoot.startsWith(resolvedBase + path.sep)) {
    throw new Error(`allocateOutputFolder: resolved path escapes TASKS_BASE: ${ticketRoot}`);
  } // path-containment verified
  // ── In-flow task allocation ──────────────────────────────────────────────
  if (context.flow === 'in-flow') {
    if (context.taskNum == null) {
      throw new Error(
        'In-flow allocation requires taskNum. Pass context.taskNum with the claimed task number.'
      );
    }
    const seg = taskSegment(context.taskNum);
    return {
      kind: 'in-flow-task',
      segment: seg,
      root: path.join(ticketRoot, seg),
      ticketRoot,
    };
  }

  // ── Out-of-flow allocation ───────────────────────────────────────────────
  if (context.flow === 'out-of-flow') {
    const isAi =
      context.origin === 'ai-subtask' || context.origin === 'ai';

    if (isAi) {
      if (!context.counters || context.counters.aiRequestNext == null) {
        throw new Error(
          'Out-of-flow AI allocation requires counters.aiRequestNext. ' +
          'Task 10 will wire the real .request-index.json counter.'
        );
      }
      const n = context.counters.aiRequestNext;
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`Invalid aiRequestNext counter: expected positive integer, got ${JSON.stringify(n)}`);
      }
      const seg = `${AI_REQUEST_PREFIX}${n}`; // counter validated above
      return {
        kind: 'out-of-flow-ai',
        segment: seg,
        root: path.join(ticketRoot, seg),
        ticketRoot,
      };
    }

    // User origin (default for out-of-flow)
    if (!context.counters || context.counters.userRequestNext == null) {
      throw new Error(
        'Out-of-flow user allocation requires counters.userRequestNext. ' +
        'Task 10 will wire the real .request-index.json counter.'
      );
    }
    const n = context.counters.userRequestNext;
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`Invalid userRequestNext counter: expected positive integer, got ${JSON.stringify(n)}`);
    }
    const seg = `${USER_REQUEST_PREFIX}${n}`;
    return {
      kind: 'out-of-flow-user',
      segment: seg,
      root: path.join(ticketRoot, seg),
      ticketRoot,
    };
  }

  // ── Legacy-root fallback ─────────────────────────────────────────────────
  // No flow/task context: return the ticket root directory.
  // Pairs with tdd-phase-state.js backward-compat legacy read path.
  return {
    kind: 'legacy-root',
    segment: null,
    root: ticketRoot,
    ticketRoot,
  };
}

module.exports = {
  allocateOutputFolder,
  taskSegment,
  TASK_SEGMENT_PREFIX,
  USER_REQUEST_PREFIX,
  AI_REQUEST_PREFIX,
};
