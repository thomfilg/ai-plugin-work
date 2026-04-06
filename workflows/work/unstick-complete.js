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
  config = require('../lib/config');
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND' && /['"]\.\.\/lib\/config['"]/.test(err.message)) {
    process.stderr.write('Config not found — run from a worktree with .envrc\n');
    process.exit(1);
  }
  throw err;
}

const TASKS_BASE = config.TASKS_BASE;
const { loadState, completeWork, addError } = require(path.join(__dirname, 'work-state'));
// session-guard is a CLI-only script (no exports), executed via execFileSync
const SESSION_GUARD_PATH = require('path').resolve(__dirname, '..', 'lib', 'hooks', 'session-guard.js');

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
  const otherSteps = Object.entries(state.stepStatus || {})
    .filter(([step]) => step !== 'complete');
  const allOthersCompleted = otherSteps.every(([, status]) => status === 'completed');
  return allOthersCompleted && (completeStatus === 'pending' || completeStatus === 'in_progress');
}

/**
 * Archive enforcement artifacts to tasks/TICKET/archive/
 */
function archiveArtifacts(ticketId) {
  const dir = path.join(TASKS_BASE, ticketId);
  const archiveDir = path.join(dir, 'archive');

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
      if (patterns.some(p => p.test(entry))) {
        files.push(entry);
      }
    }
  } catch { return []; }

  if (files.length === 0) return [];

  fs.mkdirSync(archiveDir, { recursive: true });
  const archived = [];
  for (const file of files) {
    try {
      fs.renameSync(path.join(dir, file), path.join(archiveDir, file));
      archived.push(file);
    } catch (err) {
      process.stderr.write(`Warning: could not archive ${file}: ${err.message}\n`);
    }
  }
  return archived;
}

/**
 * Finish the session guard for a ticket.
 */
function finishSessionGuard(ticketId) {
  try {
    execFileSync('node', [SESSION_GUARD_PATH, 'finish', ticketId], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Unstick a single ticket.
 */
function unstickTicket(ticketId) {
  const result = { ticketId, actions: [] };

  // Step 1: Complete work state
  const completeResult = completeWork(ticketId);
  if (completeResult && completeResult.error) {
    result.actions.push({ step: 'completeWork', ok: false, error: completeResult.error });
    addError(ticketId, 'complete', `unstick-complete: completeWork failed — ${completeResult.error}`);
  } else {
    result.actions.push({ step: 'completeWork', ok: true });
  }

  // Step 2: Finish session guard
  const guardResult = finishSessionGuard(ticketId);
  result.actions.push({ step: 'sessionGuard', ...guardResult });
  if (!guardResult.ok) {
    addError(ticketId, 'complete', `unstick-complete: session-guard finish failed — ${guardResult.error}`);
  }

  // Step 3: Archive artifacts
  const archived = archiveArtifacts(ticketId);
  result.actions.push({ step: 'archive', ok: true, files: archived });

  result.success = result.actions.every(a => a.ok !== false);
  return result;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const targetTicket = process.argv[2];

  if (targetTicket) {
    // Single ticket mode
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
    const state = loadState(dir);
    if (isStuckInComplete(state)) {
      process.stderr.write(`Found stuck ticket: ${dir}\n`);
      results.push(unstickTicket(dir));
    }
  }

  if (results.length === 0) {
    console.log(JSON.stringify({ message: 'No stuck tickets found', scanned: dirs.length }));
    process.exit(0);
    return;
  }

  console.log(JSON.stringify({ unstuck: results, total: results.length }, null, 2));
  const allOk = results.every(r => r.success);
  process.exit(allOk ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { isStuckInComplete, unstickTicket, archiveArtifacts, finishSessionGuard };
