/**
 * work-enforcement-context.js
 *
 * IDEA2 / GH-219 — Task 2: Enforcement context adapter.
 *
 * Composes work-state.js (loadState, loadActiveSubtaskState) and
 * task-parser.js (parseTasks) into a single unified EnforcementContext
 * object consumed by preflight hooks (Task 3) and enforcement gates.
 *
 * Origin derivation rules (observable signals only — no transcript reads):
 *   workflow    — .work-state.json exists AND status === 'in_progress'
 *   ai-subtask  — options.subtask is set AND loadActiveSubtaskState resolves
 *   user        — default when neither of the above applies
 *
 * Fail-closed on ambiguity: --subtask set but no matching subtask state
 * returns a structured error/remediation payload (never throws).
 *
 * @module work-enforcement-context
 */

let config;
try {
  config = require('../lib/config');
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    config = null;
  } else {
    throw err;
  }
}

const { loadState, loadActiveSubtaskState } = require('./work-state');
const { parseTasks } = require('./task-parser');

// ─── Ticket ID validation (R15) ─────────────────────────────────────────────

/**
 * @type {RegExp} Reject path-traversal sequences, slashes, backslashes, and
 * null bytes in the NORMALIZED ticket ID. Slashes are checked because
 * normalization (safeTicketId) should have already stripped them — a `/` in
 * the normalized result means normalization failed to clean the input.
 */
const UNSAFE_NORMALIZED_RE = /\.\.|[\\\/]|\x00/;

/**
 * Validate a raw ticket ID for basic type/emptiness.
 * Returns null if the basic checks pass, or an error descriptor if invalid.
 * Fail-closed: invalid IDs produce no filesystem I/O.
 *
 * @param {unknown} ticketId
 * @returns {{ code: string, message: string, remediation: string[] } | null}
 */
function validateTicketIdBasic(ticketId) {
  if (typeof ticketId !== 'string' || ticketId.length === 0) {
    return {
      code: 'INVALID_TICKET_ID',
      message: `Ticket ID must be a non-empty string, received: ${typeof ticketId === 'string' ? '""' : typeof ticketId}`,
      remediation: [
        'Pass a valid ticket ID string (e.g., "GH-219", "PROJ-42").',
        'Ensure the --ticket flag is set when invoking the command.',
      ],
    };
  }

  return null; // basic checks passed
}

/**
 * Validate a NORMALIZED ticket ID for path-traversal attacks.
 * Called AFTER safeTicketId normalization so that URL-style inputs
 * (containing slashes) have already been transformed to safe IDs.
 *
 * @param {string} normalizedId
 * @returns {{ code: string, message: string, remediation: string[] } | null}
 */
function validateNormalizedId(normalizedId) {
  if (UNSAFE_NORMALIZED_RE.test(normalizedId)) {
    return {
      code: 'INVALID_TICKET_ID',
      message: `Ticket ID contains unsafe characters (path traversal, backslash, or null byte): "${normalizedId}"`,
      remediation: [
        'Remove "..", backslashes, and null bytes from the ticket ID.',
        'Use a simple alphanumeric-with-hyphens format (e.g., "GH-219").',
      ],
    };
  } // fail-closed: reject before any I/O

  return null; // valid normalized ticket ID
}

// ─── EnforcementContext builder ──────────────────────────────────────────────

/**
 * @typedef {Object} EnforcementContextError
 * @property {string} code    - Stable string for rule-id routing (e.g., 'AMBIGUOUS_SUBTASK')
 * @property {string} message - Human-readable description
 * @property {string[]} remediation - Array of actionable fix steps
 */

/**
 * @typedef {Object} EnforcementContext
 * @property {string|null}  ticketId     - Sanitized ticket ID (null on validation error)
 * @property {'workflow'|'ai-subtask'|'user'|null} origin - Derived origin (null on validation error)
 * @property {object|null}  state        - Result from loadState(ticketId) or null
 * @property {object[]|null} tasks       - Result from parseTasks(tasksDir) or null
 * @property {object|null}  subtaskState - Active subtask state or null
 * @property {boolean}      hasWorkflow  - Whether an active workflow exists (state.status === 'in_progress')
 * @property {EnforcementContextError|null} error - null on success, structured error on ambiguity/validation failure
 * @property {object}       options      - Echo of caller-supplied options (for traceability)
 */

/**
 * Load a unified enforcement context for a ticket.
 *
 * Composes loadState, loadActiveSubtaskState, and parseTasks into a single
 * context object. Derives `origin` from observable signals only — never reads
 * transcripts.
 *
 * @param {unknown} ticketId - Raw ticket ID (will be validated and sanitized)
 * @param {object} [options={}] - Caller options
 * @param {boolean} [options.subtask] - Whether the --subtask flag was set
 * @returns {EnforcementContext}
 */
function loadEnforcementContext(ticketId, options = {}) {
  // Strip any caller-injected origin fields — origin is derived, never trusted
  const safeOptions = { subtask: Boolean(options?.subtask) };

  // ─── R15 Step 1: Basic type/emptiness check (fail-closed, no I/O) ─────
  const basicError = validateTicketIdBasic(ticketId);
  if (basicError) {
    return {
      ticketId: null,
      origin: null,
      state: null,
      tasks: null,
      subtaskState: null,
      hasWorkflow: false,
      error: basicError,
      options: safeOptions,
    };
  }

  // ─── R15 Step 2: Normalize via provider-specific sanitizer ─────────────
  // safeTicketId transforms provider-specific IDs (e.g. #N → GH-N, URLs → GH-N)
  const safeId = config && config.safeTicketId ? config.safeTicketId(ticketId) : ticketId;

  // ─── R15 Step 3: Validate NORMALIZED result for traversal attacks ──────
  const normalizedError = validateNormalizedId(safeId);
  if (normalizedError) {
    return {
      ticketId: null,
      origin: null,
      state: null,
      tasks: null,
      subtaskState: null,
      hasWorkflow: false,
      error: normalizedError,
      options: safeOptions,
    };
  }

  // ─── Load state and tasks ──────────────────────────────────────────────
  const state = loadState(safeId);
  const tasksDir = config && typeof config.tasksDir === 'function' ? config.tasksDir(safeId) : null;
  const tasks = tasksDir ? parseTasks(tasksDir) : null;

  // ─── Derive hasWorkflow ────────────────────────────────────────────────
  const hasWorkflow = !!(state && state.status === 'in_progress');

  // ─── Derive origin ─────────────────────────────────────────────────────
  let origin = 'user';
  let subtaskState = null;
  let error = null;

  if (safeOptions.subtask) {
    // --subtask flag is set: attempt to resolve active subtask state
    subtaskState = loadActiveSubtaskState(safeId);

    if (subtaskState) {
      origin = 'ai-subtask';
    } else {
      // Fail-closed: --subtask set but no resolvable subtask state
      origin = 'user';
      error = {
        code: 'AMBIGUOUS_SUBTASK',
        message:
          `--subtask flag is set but no active subtask state found for ticket "${safeId}". ` +
          'Cannot determine ai-subtask origin without a resolvable .work-state-*-subtask-*.json file.',
        remediation: [
          'Initialize a subtask first: node work-state.js init-subtask ' + safeId,
          'Verify the subtask state file exists and has status "in_progress".',
          'Remove the --subtask flag if this is not an AI-driven subtask.',
        ],
      };
    }
  } else if (hasWorkflow) {
    origin = 'workflow';
  }
  // else: origin stays 'user'

  return {
    ticketId: safeId,
    origin,
    state,
    tasks,
    subtaskState,
    hasWorkflow,
    error,
    options: safeOptions,
  };
}

module.exports = { loadEnforcementContext };
