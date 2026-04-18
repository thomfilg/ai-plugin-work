'use strict';

/**
 * Parallel worker PR{N} slot allocation and release.
 *
 * Extracted from work-state.js (GH-219 Task 7). Re-exported by
 * ../work-state.js so all existing consumers are unaffected.
 *
 * Uses lazy require for loadState/saveState/initState to avoid circular
 * dependency with the parent work-state.js module. IMPORTANT: we must NOT
 * destructure at require time — Node returns a partially-constructed exports
 * object during circular resolution. Instead we cache the module reference
 * and access properties at call time.
 */

const fs = require('fs');
const path = require('path');

// Parent module dependency injection. Set by work-state.js after it finishes
// defining loadState/saveState/initState. This avoids the Node.js circular
// require trap where module.exports replacement makes the cached reference stale.
let _parentFns = null;

/**
 * Inject parent module functions. Called once by work-state.js after its
 * own function definitions are complete.
 */
function _setParent(fns) {
  _parentFns = fns;
}

function parent() {
  if (!_parentFns) {
    // Fallback for direct-require scenarios (e.g. tests that require
    // parallel-workers.js after work-state.js is fully loaded).
    _parentFns = require('../work-state');
  }
  return _parentFns;
}

let config;
try {
  config = require('../../lib/config');
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND' && /['"]\.\.\/\.\.\/lib\/config['"]|['"]\.\.\/lib\/config['"]/.test(err.message)) {
    config = null;
  } else {
    throw err;
  }
}

// When loaded as a submodule of work-state.js, config is guaranteed to exist
// (work-state.js exits on !config). Guard defensively for direct-require
// in test harnesses that set up TASKS_BASE via env before requiring.
const TASKS_BASE = config ? config.TASKS_BASE : null; // guarded by requireTasksBase() below
const safeId = config ? config.safeTicketId : null;

/**
 * Return TASKS_BASE or throw a clear error when it is null.
 *
 * config can be null (MODULE_NOT_FOUND path in test harnesses that bypass
 * lib/config). Functions that build filesystem paths must call this instead
 * of reading TASKS_BASE directly to avoid silent path corruption via
 * `path.join(null, ...)`.
 */
function requireTasksBase() {
  if (!TASKS_BASE) {
    throw new Error(
      'TASKS_BASE is not configured. Cannot manage parallel worker slots without a valid tasks directory.'
    );
  }
  return TASKS_BASE;
}

const PARALLEL_OWNER_ID_RE = /^PR\d+$/;

/**
 * Validate a ticket id for parallel-worker allocation.
 *
 * Mirrors the fail-closed rules in `work-claims.js` `validateTicketId`.
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
  if (/[\\:\0]/.test(ticketId) || ticketId.includes('..')) {
    return {
      code: 'INVALID_TICKET_ID',
      message: `ticketId ${JSON.stringify(ticketId)} contains path separators or traversal sequences.`,
      remediation: [
        'Remove any "\\", "..", colon, or null bytes from the ticket id.',
        'Ticket ids are bare provider keys like "GH-219" or "PROJ-123" — not paths.',
      ],
    };
  }
  if (/^\/|\/\//.test(ticketId)) {
    return {
      code: 'INVALID_TICKET_ID',
      message: `ticketId ${JSON.stringify(ticketId)} contains path separators or traversal sequences.`,
      remediation: [
        'Ticket ids must not start with "/" or contain "//".',
        'A single "/" is allowed only as a suffix separator (e.g. "GH-219/phase1").',
      ],
    };
  }
  const slashCount = (ticketId.match(/\//g) || []).length;
  if (slashCount > 1) {
    return {
      code: 'INVALID_TICKET_ID',
      message: 'Only one "/" suffix separator is allowed.',
      remediation: ['Use format like "PROJ-123/phase1" — at most one "/".'],
    };
  }
  return null;
}

/**
 * Build a canonical INVALID_SLOT error descriptor.
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
  const base = requireTasksBase();
  return path.join(base, safeId(ticketId), `PR${slot}`);
}

/**
 * Allocate the next `PR{N}` worker slot for `ticketId` and create its
 * worktree directory under `${TASKS_BASE}/<safeTicketId>/PR{N}/`.
 *
 * @param {string} ticketId
 * @param {{ taskNum?: number }} [context]
 * @returns {{ success: true, slot: number, ownerId: string, dir: string } | { success: false, error: object }}
 */
function allocateWorkerSlot(ticketId, context = {}) {
  const { loadState, saveState, initState } = parent();

  // R15: validate BEFORE any filesystem I/O / directory creation.
  const ticketErr = _validateParallelTicketId(ticketId);
  if (ticketErr) return { success: false, error: ticketErr };

  let state = loadState(ticketId);
  if (!state) state = initState(ticketId);

  if (!state.parallelWorkers) {
    state.parallelWorkers = { nextSlot: 1, allocations: [] };
  }

  const slot = state.parallelWorkers.nextSlot;
  const ownerId = `PR${slot}`;
  const dir = _workerSlotDir(ticketId, slot);

  // Defensive: OWNER_ID_RE is the canonical format gate
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
  // NOTE: read-modify-write on nextSlot is NOT atomic. Two concurrent
  // processes could read the same nextSlot value and persist conflicting
  // PR{N} allocations. In practice this is safe because session-guard.js
  // acquires a ticket-level lock that serializes all callers for the same
  // ticketId before they reach this code path.
  state.parallelWorkers.nextSlot = slot + 1;

  try {
    saveState(ticketId, state);
  } catch (saveErr) {
    return {
      success: false,
      error: {
        code: 'STATE_SAVE_FAILED',
        message: `Failed to persist worker slot ${slot} for ${ticketId}: ${saveErr.message}`,
        remediation: [
          'Check filesystem permissions on the TASKS_BASE directory.',
          'Verify sufficient disk space is available.',
          'State was not persisted — retry the allocation.',
        ],
      },
    };
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (mkdirErr) {
    return {
      success: false,
      error: {
        code: 'DIR_CREATE_FAILED',
        message: `Failed to create worker directory ${dir}: ${mkdirErr.message}`,
        remediation: [
          'Check filesystem permissions on the TASKS_BASE directory.',
          'Verify sufficient disk space is available.',
          'The slot was persisted in .work-state.json — retry or release explicitly.',
        ],
      },
    };
  }

  return { success: true, slot, ownerId, dir };
}

/**
 * Release a previously-allocated `PR{N}` worker slot.
 *
 * @param {string} ticketId
 * @param {number|string} slot
 * @returns {{ success: true, idempotent?: boolean } | { success: false, error: object }}
 */
function releaseWorkerSlot(ticketId, slot) {
  const { loadState, saveState } = parent();

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
          `Inspect ${path.join(requireTasksBase(), safeId(ticketId), '.work-state.json')} → parallelWorkers.allocations for the list of valid slot numbers.`,
        ],
      },
    };
  }

  if (entry.releasedAt) {
    return { success: true, idempotent: true };
  }

  entry.releasedAt = new Date().toISOString();
  saveState(ticketId, state);
  return { success: true };
}

module.exports = {
  PARALLEL_OWNER_ID_RE,
  allocateWorkerSlot,
  releaseWorkerSlot,
  _setParent,
  // Expose internals for testing (same pattern as work-claims.js)
  _validateParallelTicketId,
  _invalidSlotError,
  _validateParallelSlot,
  _workerSlotDir,
};
