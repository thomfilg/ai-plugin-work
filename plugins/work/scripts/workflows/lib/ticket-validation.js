/**
 * ticket-validation.js — Shared ticket ID validation and sanitization (GH-219)
 *
 * Single source of truth for ticket ID safety checks used across:
 *   - allocate-output-folder.js
 *   - work-claims.js
 *   - work-enforcement-context.js
 *   - parallel-workers.js
 *   - request-index.js
 *
 * Two error models:
 *   - validateTicketId(id)        → throws on invalid (for allocator/request-index)
 *   - validateTicketIdStructured(id) → returns { code, message, remediation } or null
 *
 * @module ticket-validation
 */

'use strict';

const path = require('path');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Reject path traversal, backslash, colon, and null bytes */
const UNSAFE_TICKET_RE = /\.\.|[\\:\0]/;

// ─── Core validation logic ───────────────────────────────────────────────────

/**
 * Validate a ticket ID. Returns null on success, structured error on failure.
 * This is the canonical validation — all other validators delegate here.
 *
 * @param {unknown} ticketId
 * @returns {{ code: string, message: string, remediation: string[] } | null}
 */
function validateTicketIdStructured(ticketId) {
  if (typeof ticketId !== 'string') {
    return {
      code: 'INVALID_TICKET_ID',
      message: `ticketId must be a non-empty string (received ${ticketId === null ? 'null' : typeof ticketId}).`,
      remediation: [
        'Pass a ticket id like "GH-219" or "PROJ-123".',
        'Hooks should resolve ticket id via workflows/lib/scripts/get-ticket-id.js before calling.',
      ],
    };
  }

  const trimmed = ticketId.trim();
  if (trimmed === '') {
    return {
      code: 'INVALID_TICKET_ID',
      message: 'ticketId must be a non-empty string (received empty/whitespace).',
      remediation: ['Pass a ticket id like "GH-219" or "PROJ-123".'],
    };
  }

  // Reject whitespace-padded inputs
  if (ticketId !== trimmed) {
    return {
      code: 'INVALID_TICKET_ID',
      message: `ticketId ${JSON.stringify(ticketId)} contains leading/trailing whitespace.`,
      remediation: ['Trim the ticket id before passing it.'],
    };
  }

  // Reject bare dot segments
  if (ticketId === '.' || ticketId === './') {
    return {
      code: 'INVALID_TICKET_ID',
      message: '"." is not a valid ticket ID.',
      remediation: ['Use a proper ticket id like "GH-219" or "PROJ-123".'],
    };
  }

  // Reject unsafe characters (traversal, backslash, colon, null byte)
  if (UNSAFE_TICKET_RE.test(ticketId)) {
    return {
      code: 'INVALID_TICKET_ID',
      message: `ticketId ${JSON.stringify(ticketId)} contains unsafe characters (path traversal, backslash, colon, or null byte).`,
      remediation: [
        'Remove any "\\", "..", colon, or null bytes from the ticket id.',
        'Ticket ids are bare provider keys like "GH-219" or "PROJ-123" — not paths.',
      ],
    };
  }

  // Reject leading slash (absolute path)
  if (ticketId.startsWith('/')) {
    return {
      code: 'INVALID_TICKET_ID',
      message: `ticketId ${JSON.stringify(ticketId)} must not start with "/".`,
      remediation: ['Ticket ids must not start with "/".'],
    };
  }

  // Reject multiple slashes
  const slashCount = (ticketId.match(/\//g) || []).length;
  if (slashCount > 1) {
    return {
      code: 'INVALID_TICKET_ID',
      message: `ticketId has ${slashCount} slashes — at most one "/" is allowed.`,
      remediation: ['Use format like "PROJ-123/phase1" — at most one "/".'],
    };
  }

  // Reject trailing slash or dot-suffix
  if (slashCount === 1) {
    const suffix = ticketId.slice(ticketId.indexOf('/') + 1);
    if (!suffix || suffix === '.' || suffix === '..' || UNSAFE_TICKET_RE.test(suffix)) {
      return {
        code: 'INVALID_TICKET_ID',
        message: `ticketId ${JSON.stringify(ticketId)} has invalid suffix after "/".`,
        remediation: [
          'Either remove the trailing "/" or add a valid suffix like "PROJ-123/phase1".',
        ],
      };
    }
  } // end suffix validation — rejects empty, dot, and unsafe-char suffixes

  return null;
}

/**
 * Validate a ticket ID, throwing on failure.
 * Use this in modules that throw (allocator, request-index).
 *
 * @param {unknown} ticketId
 * @throws {Error} if ticketId is invalid
 */
function validateTicketId(ticketId) {
  const err = validateTicketIdStructured(ticketId);
  if (err) {
    throw new Error(`Invalid ticket ID: ${err.message}`);
  }
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

/**
 * Sanitize ticket ID for filesystem paths using config.safeTicketId.
 * Handles suffix syntax: splits on "/" to sanitize base independently
 * so "#123/phase1" → "GH-123/phase1".
 *
 * @param {string} ticketId - Pre-validated ticket ID
 * @returns {string}
 */
function sanitizeTicketId(ticketId) {
  try {
    const config = require('./config');
    if (config && typeof config.safeTicketId === 'function') {
      const slashIdx = ticketId.indexOf('/');
      if (slashIdx !== -1) {
        return config.safeTicketId(ticketId.slice(0, slashIdx)) + ticketId.slice(slashIdx);
      }
      return config.safeTicketId(ticketId);
    }
  } catch (err) {
    if (!err || err.code !== 'MODULE_NOT_FOUND') throw err; // only swallow missing config
  }
  return ticketId;
}

// ─── TASKS_BASE resolution ───────────────────────────────────────────────────

/**
 * Resolve TASKS_BASE from environment or config module.
 * Returns an absolute path (always path.resolve'd).
 *
 * @returns {string} Absolute path to TASKS_BASE
 * @throws {Error} if TASKS_BASE cannot be resolved
 */
function resolveTasksBase() {
  if (process.env.TASKS_BASE) return path.resolve(process.env.TASKS_BASE);
  try {
    const config = require('./config');
    if (config && config.TASKS_BASE) return path.resolve(config.TASKS_BASE);
  } catch (err) {
    if (!err || err.code !== 'MODULE_NOT_FOUND') throw err; // only swallow missing config
  }
  throw new Error('TASKS_BASE is not configured. Set TASKS_BASE (or WORKTREES_BASE in .envrc).');
}

/**
 * Resolve TASKS_BASE, returning null instead of throwing.
 * Use this in modules that return structured errors (work-claims).
 *
 * @returns {string|null}
 */
function resolveTasksBaseOrNull() {
  try {
    return resolveTasksBase();
  } catch {
    return null;
  }
}

/**
 * Resolve TASKS_BASE with a default fallback when unset.
 *
 * Preserves the legacy behavior used across per-step phase-state modules
 * (tdd-phase-state, ci-phase-state, spec-phase-state, etc.) that always
 * returned a usable path even outside a configured workspace — historically
 * `~/worktrees/tasks`. Centralized here so all callers share one source of
 * truth instead of redefining the same function in ~30 files.
 *
 * @param {string} [fallback] - Path to use when TASKS_BASE is unset.
 *   Defaults to `<HOME>/worktrees/tasks`.
 * @returns {string} Absolute path
 */
function resolveTasksBaseWithFallback(fallback) {
  if (process.env.TASKS_BASE) return path.resolve(process.env.TASKS_BASE);
  try {
    const config = require('./config');
    if (config && config.TASKS_BASE) return path.resolve(config.TASKS_BASE);
  } catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
  }
  if (fallback) return path.resolve(fallback);
  return path.join(require('os').homedir(), 'worktrees', 'tasks');
}

/**
 * Resolve the current git worktree root (output of `git rev-parse --show-toplevel`).
 * Returns null when not inside a git worktree or git is unavailable.
 *
 * Centralized here so all callers share one source of truth instead of
 * redefining the same spawnSync block in ~15 files.
 *
 * @returns {string|null}
 */
function resolveWorktreeRoot() {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

// ─── Path containment ─────────────────────────────────────────────────────────

/**
 * Verify that a resolved path is a strict child of a base directory.
 *
 * @param {string} resolvedPath - Absolute resolved path
 * @param {string} resolvedBase - Absolute resolved base
 * @param {string} [label='path'] - Label for error message
 * @throws {Error} if path escapes base
 */
function assertPathContainment(resolvedPath, resolvedBase, label = 'path') {
  // Use path.sep-terminated prefix to prevent sibling attacks (/base vs /base-extra).
  // Handle root directory edge case where base already ends with separator.
  const prefix = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  if (!resolvedPath.startsWith(prefix)) {
    throw new Error(`${label}: resolved path escapes base directory: ${resolvedPath}`);
  }
}

module.exports = {
  validateTicketId,
  validateTicketIdStructured,
  sanitizeTicketId,
  resolveTasksBase,
  resolveTasksBaseOrNull,
  resolveTasksBaseWithFallback,
  resolveWorktreeRoot,
  assertPathContainment,
  UNSAFE_TICKET_RE,
};
