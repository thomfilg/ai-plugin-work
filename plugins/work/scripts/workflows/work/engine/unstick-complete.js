#!/usr/bin/env node

/**
 * unstick-complete.js — GH-106 Recovery Script
 *
 * Scans for tickets stuck in the 'complete' step and resolves them.
 * For each stuck ticket: marks work-state as completed, finishes session guard,
 * and archives enforcement artifacts.
 *
 * Usage:
 *   node unstick-complete.js              # scan all tickets
 *   node unstick-complete.js TICKET_ID    # fix a specific ticket
 *
 * Exit codes:
 *   0 — success (or no stuck tickets found)
 *   1 — one or more tickets could not be unstuck
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Load config
let config;
try {
  config = require('../../lib/config');
} catch (err) {
  if (
    err &&
    err.code === 'MODULE_NOT_FOUND' &&
    /['"]\.\.\/\.\.\/lib\/config['"]/.test(err.message)
  ) {
    process.stderr.write('Config not found — run from a worktree with .envrc\n');
    process.exit(1);
  }
  throw err;
}

const TASKS_BASE = config.TASKS_BASE;
const { loadState, completeWork, addError } = require(path.join(__dirname, '..', 'work-state'));
// session-guard is a CLI-only script (no exports), executed via execFileSync
const SESSION_GUARD_PATH = require('path').resolve(
  __dirname,
  '..',
  '..',
  'lib',
  'hooks',
  'session-guard.js'
);

/**
 * Validate and sanitize a ticket ID to prevent path traversal.
 * Delegates ID sanitization to config.safeTicketId, then validates
 * the resolved path stays within TASKS_BASE.
 * Allows base ticket IDs (e.g. GH-106) and suffix tickets (e.g. GH-145/phase1).
 */
function sanitizeTicketId(ticketId) {
  if (!ticketId || typeof ticketId !== 'string') return null;
  if (!TASKS_BASE || typeof TASKS_BASE !== 'string') return null;
  if (ticketId.includes('\\')) return null;
  const safeId = config.safeTicketId(ticketId);
  const parts = safeId.split('/');
  if (parts.length < 1 || parts.length > 2) return null;
  if (parts.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  const baseResolved = path.resolve(TASKS_BASE);
  const resolved = path.resolve(TASKS_BASE, ...parts);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) return null;
  return safeId; // validated: alphanumeric with optional single /suffix, resolves within TASKS_BASE
}

/**
 * Determine if a ticket is stuck in the complete step.
 * Stuck means: status is 'in_progress' and the complete step is 'in_progress'
 * (or all other steps are completed but complete is pending/in_progress).
 */
function isStuckInComplete(state) {
  if (!state || state.status === 'completed') return false;
  if (state.status !== 'in_progress') return false;

  const completeStatus = state.stepStatus?.complete;
  if (completeStatus === 'in_progress') return true;

  // All other steps completed but complete is still pending
  const otherSteps = Object.entries(state.stepStatus || {}).filter(([step]) => step !== 'complete');
  const allOthersCompleted = otherSteps.every(([, status]) => status === 'completed');
  return allOthersCompleted && (completeStatus === 'pending' || completeStatus === 'in_progress');
}

/**
 * Archive enforcement artifacts to tasks/TICKET/archive/
 */
function archiveArtifacts(ticketId) {
  const safe = sanitizeTicketId(ticketId);
  if (!safe) return [];
  const dir = path.join(TASKS_BASE, safe);
  const archiveDir = path.join(dir, 'archive');

  // Enforcement artifact patterns to archive (ticketId is sanitized above)
  const patterns = [
    /^.*\.check\.md$/,
    /^\.work-actions\.json$/,
    /^tdd-phase\.json$/,
    /^\.step-evidence\.json$/,
  ];

  const files = [];
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (patterns.some((p) => p.test(entry))) {
        files.push(entry);
      }
    }
  } catch {
    return [];
  }

  if (files.length === 0) return [];

  fs.mkdirSync(archiveDir, { recursive: true });
  const archived = [];
  for (const file of files) {
    try {
      let dest = path.join(archiveDir, file);
      // Avoid overwriting existing archived files — append timestamp suffix
      if (fs.existsSync(dest)) {
        dest = path.join(archiveDir, `${Date.now()}-${file}`);
      }
      fs.renameSync(path.join(dir, file), dest);
      archived.push(file);
    } catch (err) {
      process.stderr.write(`Warning: could not archive ${file}: ${err.message}\n`);
    }
  }
  return archived; // idempotent: existing dest files get timestamped suffix
}

/**
 * Finish the session guard for a ticket.
 */
function finishSessionGuard(ticketId) {
  const safe = sanitizeTicketId(ticketId);
  if (!safe) return { ok: false, error: 'Invalid ticket ID' };
  // session-guard uses base ticket ID (no suffix) to match init/finish pairing
  const baseId = safe.split('/')[0];
  try {
    execFileSync('node', [SESSION_GUARD_PATH, 'finish', baseId], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true }; // baseId extracted from safe (split('/')[0]) to match session-guard init/finish pairing
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Unstick a single ticket.
 */
function unstickTicket(ticketId) {
  const safe = sanitizeTicketId(ticketId);
  if (!safe) return { ticketId, actions: [], success: false, error: 'Invalid ticket ID' };
  const result = { ticketId: safe, actions: [] };

  // Step 1: Complete work state (try/catch protects against unexpected throws)
  let completeResult;
  try {
    completeResult = completeWork(safe);
  } catch (err) {
    completeResult = { error: err.message };
  }
  if (completeResult && completeResult.error) {
    result.actions.push({ step: 'completeWork', ok: false, error: completeResult.error });
    if (completeResult.error === 'No state found') {
      result.success = false;
      return result;
    }
    try {
      addError(safe, 'complete', `unstick-complete: completeWork failed — ${completeResult.error}`);
    } catch {
      /* best-effort */
    }
  } else {
    result.actions.push({ step: 'completeWork', ok: true });
  }

  // Step 2: Finish session guard
  const guardResult = finishSessionGuard(safe);
  result.actions.push({ step: 'sessionGuard', ...guardResult });
  if (!guardResult.ok && completeResult && !completeResult.error) {
    try {
      addError(
        safe,
        'complete',
        `unstick-complete: session-guard finish failed — ${guardResult.error}`
      );
    } catch {
      /* best-effort */
    }
  }

  // Step 3: Archive artifacts
  const archived = archiveArtifacts(safe);
  result.actions.push({ step: 'archive', ok: true, files: archived });

  result.success = result.actions.every((a) => a.ok !== false);
  return result;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const targetTicket = process.argv[2];

  if (targetTicket) {
    // Single ticket mode — validate early
    if (!sanitizeTicketId(targetTicket)) {
      process.stderr.write(`Invalid ticket ID: ${targetTicket}\n`);
      process.exit(1);
      return;
    }
    const result = unstickTicket(targetTicket);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
    return;
  }

  // Scan mode: find all stuck tickets
  const results = [];
  let dirs;
  try {
    dirs = fs.readdirSync(TASKS_BASE);
  } catch {
    process.stderr.write(`Cannot read TASKS_BASE: ${TASKS_BASE}\n`);
    process.exit(1);
    return;
  }

  for (const dir of dirs) {
    // Check base ticket (sanitized by unstickTicket internally)
    const state = loadState(dir);
    if (isStuckInComplete(state)) {
      process.stderr.write(`Found stuck ticket: ${dir}\n`);
      results.push(unstickTicket(dir));
    }
    // Also check suffix tickets (e.g. GH-145/phase1) stored under subdirectories
    const subDir = path.join(TASKS_BASE, dir);
    try {
      const subs = fs.readdirSync(subDir, { withFileTypes: true });
      for (const sub of subs) {
        if (!sub.isDirectory()) continue;
        const suffixId = `${dir}/${sub.name}`;
        const suffixState = loadState(suffixId);
        if (isStuckInComplete(suffixState)) {
          process.stderr.write(`Found stuck suffix ticket: ${suffixId}\n`);
          results.push(unstickTicket(suffixId));
        }
      }
    } catch {
      /* not a directory or not readable */
    }
  }

  if (results.length === 0) {
    console.log(JSON.stringify({ message: 'No stuck tickets found', scanned: dirs.length }));
    process.exit(0);
    return;
  }

  console.log(JSON.stringify({ unstuck: results, total: results.length }, null, 2));
  const allOk = results.every((r) => r.success);
  process.exit(allOk ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  isStuckInComplete,
  unstickTicket,
  archiveArtifacts,
  finishSessionGuard,
  sanitizeTicketId,
};
