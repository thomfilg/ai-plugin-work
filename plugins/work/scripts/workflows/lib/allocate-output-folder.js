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
const {
  validateTicketId,
  sanitizeTicketId: sanitizeId,
  resolveTasksBase,
  assertPathContainment,
} = require('./ticket-validation');

// ─── Constants (R7 naming policy) ────────────────────────────────────────────

const TASK_SEGMENT_PREFIX = 'task';
const USER_REQUEST_PREFIX = 'user-request-';
const AI_REQUEST_PREFIX = 'ai-request-';

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Produce the canonical `task${N}` segment name (R7 single source of truth).
 *
 * @param {number} taskNum - Positive integer task number
 * @returns {string} e.g. "task1", "task9", "task42"
 * @throws {Error} if taskNum is not a positive integer
 */
function taskSegment(taskNum) {
  if (typeof taskNum !== 'number' || !Number.isInteger(taskNum) || taskNum < 1) {
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
  const safeId = sanitizeId(ticketId); // may transform #N → GH-N
  // Re-validate after sanitization in case safeTicketId introduced unsafe chars
  validateTicketId(safeId);
  const ticketRoot = path.resolve(tasksBase, safeId);
  assertPathContainment(ticketRoot, tasksBase, 'allocateOutputFolder');
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
      root: path.resolve(ticketRoot, seg),
      ticketRoot,
    }; // in-flow result — paths are absolute (tasksBase resolved)
  }

  // ── Out-of-flow allocation ───────────────────────────────────────────────
  if (context.flow === 'out-of-flow') {
    const isAi = context.origin === 'ai-subtask' || context.origin === 'ai';

    if (isAi) {
      if (!context.counters || context.counters.aiRequestNext == null) {
        throw new Error(
          'Out-of-flow AI allocation requires counters.aiRequestNext. ' +
            'Task 10 will wire the real .request-index.json counter.'
        );
      }
      const n = context.counters.aiRequestNext;
      if (!Number.isInteger(n) || n < 1)
        throw new Error(
          `Invalid aiRequestNext counter: expected positive integer, got ${String(n)}`
        );
      const seg = `${AI_REQUEST_PREFIX}${n}`;
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
    if (!Number.isInteger(n) || n < 1)
      throw new Error(
        `Invalid userRequestNext counter: expected positive integer, got ${String(n)}`
      );
    const seg = `${USER_REQUEST_PREFIX}${n}`;
    return {
      kind: 'out-of-flow-user',
      segment: seg,
      root: path.join(ticketRoot, seg),
      ticketRoot,
    };
  }

  // ── Reject unknown flow values ───────────────────────────────────────────
  if (context.flow != null && context.flow !== 'in-flow' && context.flow !== 'out-of-flow') {
    throw new Error(
      `Unknown flow type: ${String(context.flow)}. Expected "in-flow", "out-of-flow", or undefined.`
    );
  }

  // ── Legacy-root fallback ─────────────────────────────────────────────────
  // No flow/task context: return the ticket root directory.
  return {
    kind: 'legacy-root',
    segment: null,
    root: ticketRoot,
    ticketRoot,
  };
} // end allocateOutputFolder

module.exports = {
  allocateOutputFolder,
  taskSegment,
  TASK_SEGMENT_PREFIX,
  USER_REQUEST_PREFIX,
  AI_REQUEST_PREFIX,
};
