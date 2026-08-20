#!/usr/bin/env node

/**
 * work-claims.js — Per-task atomic claim locks.
 *
 * IDEA2 / GH-219 — Task 6 (R5, R15).
 *
 * Provides atomic `claimTask` / `releaseTask` helpers that persist a lock
 * file at `TASKS_BASE/<ticketId>/.claims/task-${n}.lock`. Exactly one
 * concurrent caller wins the lock; every other caller sees a structured
 * `ALREADY_CLAIMED` error carrying the winning owner id.
 *
 * Atomicity primitive:
 *   `rename(2)` SILENTLY OVERWRITES its target (verified locally: Linux 6.6),
 *   which is right for writeSessionAtomic (update-in-place) but cannot express
 *   the "create if not exists" semantic a lock needs. The exclusive-create
 *   (O_CREAT|O_EXCL) used here fails with EEXIST when the target exists, which
 *   is the winner-takes-all behaviour we want. It comes from the shared lock in
 *   `workflows/lib/storeMigration/lock.js` — the same primitive the migration
 *   runner and the maestro conductor use. (This previously hand-rolled a temp
 *   file plus `fs.linkSync`; the shared version needs no temp file, so the
 *   `.tmp-*` cleanup it required is gone with it.)
 *
 * Shared helper vs. `writeSessionAtomic` — decision (unchanged):
 *   `writeSessionAtomic(ticketId, data)` in `workflows/lib/hooks/session-guard.js`
 *   implements atomic OVERWRITE (delete target, then rename). This module
 *   needs atomic CREATE-IF-NOT-EXISTS (never clobber a live lock). The two
 *   surfaces diverge on outcome — OVERWRITE never fails on EEXIST, CLAIM
 *   ONLY fails on EEXIST — so they stay separate. That reasoning is about
 *   OVERWRITE-vs-CREATE, and does not apply to the create-if-not-exists locks
 *   this module now shares with the conductor and the migration runner.
 *
 * What stays local to this module: ownership policy. Same-owner reclaim is
 * idempotent, a refused claim reports the winning owner, and `releaseTask`
 * refuses to delete another owner's lock. The shared primitive owns atomicity;
 * this file owns who may hold what.
 *
 * Ticket-scoped session guarding in `workflows/lib/hooks/session-guard.js`
 * is NOT modified by this module — task claims sit beneath the session
 * guard, and the two surfaces never touch the same files.
 *
 * Module API:
 *   claimTask(ticketId, taskNum, ownerId)  → Result
 *   releaseTask(ticketId, taskNum, ownerId) → Result
 *
 * Result shape:
 *   Success:    { success: true, ownerId, lockPath, existingOwner?, idempotent?: true }
 *   Rejection:  { success: false, existingOwner?, lockPath?, error: { code, message, remediation[] } }
 *
 * Error codes (returned as error.code):
 *   INVALID_TICKET_ID  — ticketId missing / empty / traversal / non-string
 *   INVALID_OWNER_ID   — owner id does not match /^PR[1-9]\d*$/
 *   INVALID_TASK_NUM   — task number is not a positive integer
 *   ALREADY_CLAIMED    — task-${n}.lock already exists with a different owner
 *   WRONG_OWNER        — releaseTask called by a non-owner
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Config resolution ──────────────────────────────────────────────────────
// Mirrors work-state.js: tolerate missing config (e.g. during partial
// bootstrap) by exposing a helper rather than failing at require() time.
let config;
try {
  config = require('../../lib/config');
} catch (err) {
  if (
    err &&
    err.code === 'MODULE_NOT_FOUND' &&
    /['"]\.\.\/\.\.\/lib\/config['"]/.test(err.message)
  ) {
    config = null;
  } else {
    throw err;
  }
}

function getTasksBase() {
  // Always prefer a live env var read so tests that mutate TASKS_BASE
  // between invocations still resolve to the isolated temp directory
  // (matches the work-state-graph.test.js contract — see its header
  // comment on module-load timing).
  const envBase = process.env.TASKS_BASE; // tests override this
  return envBase || (config && config.TASKS_BASE) || null;
}

// ─── Input validation ──────────────────────────────────────────────────────
// R15 fail-closed: every validation helper returns null on success and a
// structured error object on failure. Callers short-circuit at the first
// error so we never touch the filesystem with bad input (no directory
// creation, no rename target resolution).

const OWNER_ID_RE = /^PR[1-9]\d*$/;

function validateTicketId(ticketId) {
  if (typeof ticketId !== 'string') {
    return {
      code: 'INVALID_TICKET_ID',
      message: `ticketId must be a non-empty string (received ${ticketId === null ? 'null' : typeof ticketId}).`,
      remediation: [
        'Pass a ticket id like "GH-219" or "PROJ-123".',
        'Hooks should resolve ticket id via workflows/lib/scripts/get-ticket-id.js before calling claimTask.',
      ],
    };
  }
  const trimmed = ticketId.trim();
  if (trimmed === '') {
    return {
      code: 'INVALID_TICKET_ID',
      message: 'ticketId must be a non-empty string (received empty/whitespace).',
      remediation: [
        'Pass a ticket id like "GH-219" or "PROJ-123".',
        'Hooks should resolve ticket id via workflows/lib/scripts/get-ticket-id.js before calling claimTask.',
      ],
    };
  }
  // Reject whitespace-padded inputs — callers must normalize before calling.
  if (ticketId !== trimmed) {
    return {
      code: 'INVALID_TICKET_ID',
      message: `ticketId ${JSON.stringify(ticketId)} contains leading/trailing whitespace.`,
      remediation: ['Trim the ticket id before passing it to claimTask/releaseTask.'],
    };
  }
  // Expects pre-normalized ticket ID (e.g. "GH-219", not a URL).
  // See loadEnforcementContext which normalizes URLs before calling
  // downstream modules — by the time we reach this point the ticketId is
  // always a bare provider key like "GH-219" or "PROJ-123", optionally
  // with a slash suffix like "GH-219/phase1" (see parseTicketInput in
  // workflows/lib/ticket-provider.js).
  // Reject backslash, colon, null byte, and traversal sequences.
  // At this point ticketId === trimmed (whitespace rejected above).
  const hasDangerousChars = /[\\:\0]/.test(ticketId) || ticketId.includes('..');
  if (hasDangerousChars) {
    return {
      code: 'INVALID_TICKET_ID',
      message: `ticketId ${JSON.stringify(ticketId)} contains path separators or traversal sequences.`,
      remediation: [
        'Remove any "\\", "..", colon, or null bytes from the ticket id.',
        'Ticket ids are bare provider keys like "GH-219" or "PROJ-123" — not paths.',
      ],
    };
  }
  // Reject absolute paths (starts with /) and multiple slashes.
  // A single "/" is allowed for suffixed tickets like "GH-219/phase1".
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
  // Reject more than one slash — "A/B/C" must not pass even though it has
  // no leading slash or consecutive slashes.
  const slashCount = (ticketId.match(/\//g) || []).length;
  if (slashCount > 1) {
    // "A/B/C" — only one "/" allowed
    return {
      code: 'INVALID_TICKET_ID',
      message: 'Only one "/" suffix separator is allowed.',
      remediation: ['Use format like "PROJ-123/phase1" — at most one "/".'],
    };
  }
  // Reject trailing slash with no suffix (e.g. "GH-219/")
  if (ticketId.endsWith('/')) {
    return {
      code: 'INVALID_TICKET_ID',
      message: `ticketId ${JSON.stringify(ticketId)} has a trailing "/" with no suffix.`,
      remediation: ['Either remove the trailing "/" or add a suffix like "PROJ-123/phase1".'],
    };
  }
  return null;
}

function validateOwnerId(ownerId) {
  if (typeof ownerId !== 'string' || !OWNER_ID_RE.test(ownerId)) {
    return {
      code: 'INVALID_OWNER_ID',
      message: `ownerId ${JSON.stringify(ownerId)} does not match /^PR[1-9]\\d*$/ (positive integer required).`,
      remediation: [
        'Use the canonical slot id emitted by the PR{N} allocator (e.g. "PR1", "PR2").',
        'Owner ids are "PR" followed by a positive integer (PR0 is not valid).',
      ],
    }; // end INVALID_OWNER_ID
  }
  return null;
}

function invalidTaskNumError(taskNum) {
  return {
    code: 'INVALID_TASK_NUM',
    message: `taskNum ${JSON.stringify(taskNum)} must be a positive integer.`,
    remediation: [
      'Pass a positive integer (1, 2, 3, ...) matching `## Task N` in tasks.md.',
      'Task numbers are 1-indexed; task-parser.js emits them as integers.',
    ],
  };
}

/**
 * Normalize `taskNum` to a positive integer or return a structured error.
 * Accepts a number or a plain-digit string ("3", "42"). Rejects non-integers,
 * decimals, negative values, zero, NaN, empty strings, and non-primitives.
 *
 * Unlike the other validators (which return `null` on success), this one
 * returns `{ error: null, value: <int> }` on success so callers can capture
 * the coerced integer in a single step.
 */
function validateTaskNum(taskNum) {
  if (typeof taskNum === 'string') {
    if (!/^\d+$/.test(taskNum)) return { error: invalidTaskNumError(taskNum), value: null };
    taskNum = Number(taskNum);
  }
  if (!Number.isInteger(taskNum) || taskNum <= 0) {
    return { error: invalidTaskNumError(taskNum), value: null };
  }
  return { error: null, value: taskNum };
}

/**
 * Shared validation prologue for `claimTask` / `releaseTask`. Fails closed
 * on the first error (R15: no FS I/O before inputs are clean). Returns
 * either `{ error: <structured> }` or `{ taskNumInt: <positive int> }`.
 */
function validateAll(ticketId, taskNum, ownerId) {
  const ticketErr = validateTicketId(ticketId);
  if (ticketErr) return { error: ticketErr };
  const ownerErr = validateOwnerId(ownerId);
  if (ownerErr) return { error: ownerErr };
  const { error: taskErr, value: taskNumInt } = validateTaskNum(taskNum);
  if (taskErr) return { error: taskErr };
  return { taskNumInt };
}

// ─── Path builders (only after validation passes) ──────────────────────────

function safeTicketFragment(ticketId) {
  // Reuse config.safeTicketId when available (handles provider-specific
  // canonicalization like "#42" → "GH-42"). For suffixed ids like
  // "#42/phase1", split on "/" and sanitize only the base so that
  // sanitizeTicketIdForPath's regex can match the bare "#N" form.
  if (config && typeof config.safeTicketId === 'function') {
    try {
      const slashIdx = ticketId.indexOf('/');
      if (slashIdx !== -1) {
        const base = ticketId.slice(0, slashIdx);
        const suffix = ticketId.slice(slashIdx); // includes the "/"
        return config.safeTicketId(base) + suffix;
      }
      return config.safeTicketId(ticketId);
    } catch {
      return ticketId;
    }
  }
  return ticketId;
} // end safeTicketFragment — handles base/suffix split for #N → GH-N

function claimsDirFor(ticketId) {
  const tasksBase = getTasksBase();
  if (!tasksBase) {
    throw new Error(
      'TASKS_BASE is not configured — set TASKS_BASE in your environment (or WORKTREES_BASE in .envrc so config.js derives it).'
    );
  }
  const dir = path.join(tasksBase, safeTicketFragment(ticketId), '.claims');
  // Defense-in-depth: ensure computed path stays under TASKS_BASE.
  const resolvedDir = path.resolve(dir);
  const resolvedBase = path.resolve(tasksBase);
  if (resolvedDir !== resolvedBase && !resolvedDir.startsWith(resolvedBase + path.sep)) {
    throw new Error(`claimsDirFor: computed path escapes TASKS_BASE: ${dir}`);
  }
  return dir;
}

function lockPathFor(ticketId, taskNumInt) {
  return path.join(claimsDirFor(ticketId), `task-${taskNumInt}.lock`);
}

// ─── Payload read (best-effort) ────────────────────────────────────────────

const { createFileLock } = require(
  path.join(__dirname, '..', '..', 'lib', 'storeMigration', 'lock')
);

// A task claim is held until it is explicitly released: no age-based expiry
// and no liveness probe, so a conflict is always a refusal. The atomic
// create / bounded retry / unreadable-holder handling is shared with the
// migration runner and the maestro conductor.
const locker = createFileLock({
  lockPathFor: (file) => file,
  mode: 0o600,
});

function readLockOwner(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.ownerId === 'string') return parsed.ownerId;
  } catch {
    /* ENOENT / corrupt / races — fall through */
  }
  return null;
}

// ─── claimTask ─────────────────────────────────────────────────────────────

/**
 * Attempt to claim task `taskNum` on ticket `ticketId` for owner `ownerId`.
 *
 * Atomic across concurrent racers on the same host: the first caller to
 * successfully link() its temp file into `.claims/task-${n}.lock` wins;
 * every other caller sees `EEXIST` and returns `ALREADY_CLAIMED`. Idempotent
 * for the same owner (re-claiming returns `success: true` and the live
 * owner id).
 *
 * @param {string} ticketId
 * @param {number|string} taskNum - 1-indexed task number (digit string OK)
 * @param {string} ownerId        - `PR{N}` where N is a positive integer
 * @returns {{success:boolean, ownerId?:string, existingOwner?:string, lockPath?:string, idempotent?:boolean, error?:{code:string,message:string,remediation:string[]}}}
 */
function claimTask(ticketId, taskNum, ownerId) {
  // R15: ALL validation before ANY filesystem I/O / directory creation.
  const validated = validateAll(ticketId, taskNum, ownerId);
  if (validated.error) return { success: false, error: validated.error };
  const { taskNumInt } = validated;

  // Build paths — safe to touch the filesystem from here on.
  const claimsDir = claimsDirFor(ticketId);
  const lockPath = lockPathFor(ticketId, taskNumInt);
  fs.mkdirSync(claimsDir, { recursive: true });

  const payload = {
    ownerId,
    taskNum: taskNumInt,
    ticketId: safeTicketFragment(ticketId), // canonical form matches lock path
    timestamp: new Date().toISOString(),
  };

  const res = locker.acquire(lockPath, { payload });
  if (res.ok) return { success: true, ownerId, lockPath };

  // Held. Read the owner off the refused lock (best-effort — an unreadable
  // body reports as null, which is still a refusal, never a takeover).
  const existingOwner = res.held && typeof res.held.ownerId === 'string' ? res.held.ownerId : null;

  // Idempotent: the same owner reclaiming its own task is not an error.
  if (existingOwner === ownerId) {
    return { success: true, ownerId, existingOwner, lockPath, idempotent: true };
  }

  return {
    success: false,
    existingOwner: existingOwner || null,
    lockPath,
    error: {
      code: 'ALREADY_CLAIMED',
      message: existingOwner
        ? `Task ${taskNumInt} on ${ticketId} is already claimed by ${existingOwner}.`
        : `Task ${taskNumInt} on ${ticketId} is already claimed (owner unreadable).`,
      remediation: [
        `Wait for ${existingOwner || 'the current owner'} to call releaseTask or complete.`,
        `Pick a different task (see canStart in workflows/work/work-state.js for readiness).`,
        `If the lock is stale, inspect ${lockPath} manually before removing.`,
      ],
    },
  };
}

// ─── releaseTask ───────────────────────────────────────────────────────────

/**
 * Release a previously-acquired claim. No-op (still success) when the lock
 * file is absent — callers that need strict presence checks should inspect
 * the filesystem themselves.
 *
 * @param {string} ticketId
 * @param {number|string} taskNum
 * @param {string} ownerId
 * @returns {{success:boolean, existingOwner?:string, lockPath?:string, idempotent?:boolean, error?:object}}
 */
function releaseTask(ticketId, taskNum, ownerId) {
  // Same validation gate as claimTask — no FS work before all inputs pass.
  const validated = validateAll(ticketId, taskNum, ownerId);
  if (validated.error) return { success: false, error: validated.error };
  const { taskNumInt } = validated;

  const lockPath = lockPathFor(ticketId, taskNumInt);

  // Lock is already gone — idempotent success. This keeps restart / retry
  // flows clean: a worker that crashed mid-release can safely re-release.
  if (!fs.existsSync(lockPath)) {
    return { success: true, lockPath, idempotent: true };
  }

  const existingOwner = readLockOwner(lockPath);

  // TOCTOU guard: if readLockOwner returns null the lock file may have been
  // deleted between the existsSync check above and the readFileSync inside
  // readLockOwner. Re-check existence — if the file is gone, treat as
  // idempotent success (another process already released it).
  if (!existingOwner && !fs.existsSync(lockPath)) {
    return { success: true, lockPath, idempotent: true };
  }

  if (existingOwner !== ownerId) {
    return {
      success: false,
      existingOwner: existingOwner || null,
      lockPath,
      error: {
        code: 'WRONG_OWNER',
        message: existingOwner
          ? `Cannot release task ${taskNumInt} on ${ticketId}: current owner is ${existingOwner}, not ${ownerId}.`
          : `Cannot release task ${taskNumInt} on ${ticketId}: lock payload unreadable (refusing to delete).`,
        remediation: [
          `Only the current owner (${existingOwner || 'unknown'}) may call releaseTask.`,
          `Verify ownerId matches the value stored at ${lockPath}.`,
        ],
      },
    };
  }

  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // Lost a race with another releaser — idempotent success.
      return { success: true, lockPath, idempotent: true };
    }
    throw err;
  }
  return { success: true, lockPath };
}

module.exports = {
  claimTask,
  releaseTask,
  // Exported for Task 7 (PR{N} allocation) so callers don't reimplement
  // path resolution. Not part of the public hook contract.
  _internals: {
    claimsDirFor,
    lockPathFor,
    OWNER_ID_RE,
  },
};
