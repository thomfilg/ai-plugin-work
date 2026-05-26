#!/usr/bin/env node

/**
 * follow-up-next.js — Script-driven orchestrator for /follow-up.
 *
 * Outputs a SINGLE instruction. Auto-advance hook calls this after each step.
 *
 * IMPORTANT: No step-specific logic here. Steps live in lib/steps/.
 *
 * Usage: node follow-up-next.js <TICKET_ID> [--pr N] [--init]
 */

'use strict';

const fs = require('fs');
const path = require('path');

if (require.main === module) {
  process.on('uncaughtException', (err) => {
    console.error(
      JSON.stringify({
        type: 'follow_up_instruction',
        action: 'blocked',
        reason: `Uncaught exception: ${err.message}`,
        stack: err.stack,
      })
    );
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        type: 'follow_up_instruction',
        action: 'blocked',
        reason: `Unhandled rejection: ${msg}`,
      })
    );
    process.exit(1);
  });
}

// ─── Resolve paths ──────────────────────────────────────────────────────────
const { resolvePluginPaths } = require(
  path.join(__dirname, '..', 'work', 'lib', 'resolve-plugin-root')
);
const { libDir } = resolvePluginPaths(path.join(__dirname, '..', 'work'), 2);
const getConfig = require(path.join(libDir, 'get-config'));

const WORKTREES_BASE = getConfig('WORKTREES_BASE') || '';
const TASKS_BASE =
  getConfig('TASKS_BASE') || (WORKTREES_BASE ? path.join(WORKTREES_BASE, 'tasks') : '');
const MAIN_WORKTREE_FOLDER = process.env.REPO_NAME || 'my-project';

if (!TASKS_BASE) {
  console.log(
    JSON.stringify({
      type: 'follow_up_instruction',
      action: 'blocked',
      reason: 'TASKS_BASE not configured',
    })
  );
  process.exit(0);
}

// Ticket provider for ID sanitization
let tp;
try {
  tp = require(path.join(libDir, 'ticket-provider'));
} catch {
  console.log(
    JSON.stringify({
      type: 'follow_up_instruction',
      action: 'blocked',
      reason: 'ticket-provider not found',
    })
  );
  process.exit(0);
}

// ─── Step registry ──────────────────────────────────────────────────────────
const { runStep, STEPS } = require(path.join(__dirname, 'lib', 'step-registry'));

// ─── State management ───────────────────────────────────────────────────────

function stateFile(ticketId) {
  return path.join(TASKS_BASE, ticketId, '.follow-up-state.json');
}

function loadState(ticketId) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(ticketId), 'utf8'));
  } catch {
    return null;
  }
}

function saveState(ticketId, state) {
  const dir = path.join(TASKS_BASE, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile(ticketId), JSON.stringify(state, null, 2));
}

function initState(ticketId, prNumber) {
  return {
    ticketId,
    prNumber: prNumber || null,
    currentStep: STEPS[0],
    status: 'in_progress',
    dispatched: null,
    attempt: 0,
    maxAttempts: 40,
    lastMonitorResult: null,
    failureCategory: null,
    startTime: new Date().toISOString(),
  };
}

// ─── Core orchestrator loop ─────────────────────────────────────────────────

function getNextInstruction(ticketId, prNumber) {
  let state = loadState(ticketId) || initState(ticketId, prNumber);
  if (prNumber && !state.prNumber) state.prNumber = prNumber;

  const tasksDir = path.join(TASKS_BASE, ticketId);
  const candidateWorktree = path.join(WORKTREES_BASE, `${MAIN_WORKTREE_FOLDER}-${ticketId}`);
  const worktreeDir = fs.existsSync(candidateWorktree) ? candidateWorktree : process.cwd();
  const ctx = {
    tasksDir,
    worktreeDir,
    TASKS_BASE,
    workScriptsDir: path.join(__dirname, '..', 'work', 'scripts'),
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (state.status === 'complete' || !STEPS.includes(state.currentStep)) {
      // Re-verify against GitHub before honoring a saved "complete". The
      // saved state is a cache of a prior run's decision; if anything has
      // changed (new pushes, checks now running, merge state now blocked)
      // we must NOT silently return "Already complete" — that's how PR
      // #1929 cleared its session guard with 9 in-progress checks and 2
      // unpushed commits.
      //
      // Rule: honor the cache only when the PR mirrors a clickable
      // Squash-and-merge button (mergeable === true). Otherwise rewind
      // status to in_progress and let the loop re-evaluate the current
      // step from live GitHub state.
      if (state.prNumber) {
        let liveMergeable = null;
        let actionable = false;
        let realBlockers = [];
        try {
          const { assessMergeable, hasActionableBlockers } = require(
            path.join(__dirname, '..', 'work', 'lib', 'pr-mergeable.js')
          );
          liveMergeable = assessMergeable(state.prNumber);
          // hasActionableBlockers centralises the two guards (filter out
          // gh_error transients, require prState=OPEN) shared with
          // ci-gate.js. See pr-mergeable.js for the full rationale.
          const action = hasActionableBlockers(liveMergeable);
          actionable = action.actionable;
          realBlockers = action.realBlockers;
        } catch {
          liveMergeable = null;
        }
        if (actionable) {
          const blockerSummary = realBlockers.map((b) => b.kind).join(', ');
          process.stderr.write(
            `[follow-up-next] saved state said complete but PR #${state.prNumber} is not mergeable (${blockerSummary}); rewinding and resuming.\n`
          );
          state.status = 'in_progress';
          // Always reset to the first step on rewind. The saved currentStep
          // is untrustworthy (the workflow already claimed to have finished
          // it); resuming from a later step would just loop forward and
          // re-set status='complete' in the next normal-advance branch.
          // Restarting from monitor forces a fresh CI rollup read.
          state.currentStep = STEPS[0];
          state.dispatched = null;
          saveState(ticketId, state);
          continue;
        }
      }
      saveState(ticketId, state);
      return { type: 'follow_up_instruction', action: 'complete', summary: 'Already complete.' };
    }

    const stepIdx = STEPS.indexOf(state.currentStep);
    const result = runStep(state.currentStep, state, ctx);

    if (result) {
      saveState(ticketId, state);
      return result;
    }

    // null → advance (unless step set currentStep for looping)
    const currentStepAfter = state.currentStep;
    if (currentStepAfter !== STEPS[stepIdx]) {
      // Step changed currentStep (e.g., triage → fix-ci, or push-retry → monitor)
      state.dispatched = null;
      saveState(ticketId, state);
      continue;
    }

    // Normal advance to next step
    const nextIdx = stepIdx + 1;
    if (nextIdx >= STEPS.length) {
      state.status = 'complete';
      saveState(ticketId, state);
      return {
        type: 'follow_up_instruction',
        action: 'complete',
        summary: `Follow-up complete for ${ticketId}.`,
      };
    }

    state.currentStep = STEPS[nextIdx];
    state.dispatched = null;
    saveState(ticketId, state);
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(
      JSON.stringify({
        type: 'follow_up_instruction',
        action: 'blocked',
        reason: 'No ticket ID provided',
      })
    );
    process.exit(0);
  }

  const ticketRaw = args.filter((a) => !a.startsWith('--'))[0];
  const prIdx = args.indexOf('--pr');
  const prNumber = prIdx >= 0 ? parseInt(args[prIdx + 1], 10) : null;
  const isInit = args.includes('--init');

  // Sanitize ticket ID: #279 → GH-279
  const providerConfig = tp.getProviderConfig({ skipPrompt: true });
  const safeName = tp.sanitizeTicketIdForPath(ticketRaw, providerConfig);

  if (isInit) {
    const markerDir = path.join(TASKS_BASE, safeName);
    fs.mkdirSync(markerDir, { recursive: true });
    // Force-reset any existing state (e.g., stale "complete" from previous run)
    const existingState = path.join(markerDir, '.follow-up-state.json');
    if (fs.existsSync(existingState)) fs.unlinkSync(existingState);
    fs.writeFileSync(
      path.join(markerDir, '.follow-up-orchestrator.pid'),
      JSON.stringify({
        ticket: safeName,
        startedAt: new Date().toISOString(),
        workflow: '/follow-up',
      })
    );
    // Register session guard so Stop hook blocks abandonment.
    // Idempotent: a parent /work session for the same ticket is reused.
    try {
      const { spawnSync } = require('child_process');
      const sessionGuardPath = path.join(__dirname, '..', 'lib', 'hooks', 'session-guard.js');
      spawnSync('node', [sessionGuardPath, 'init', safeName, '/follow-up'], {
        stdio: 'inherit',
        timeout: 5000,
      });
    } catch {
      /* fail-open — session guard is advisory */
    }
  }

  const instruction = getNextInstruction(safeName, prNumber);

  // When the workflow completes, release the session guard ONLY if /follow-up
  // owns it (the `complete <id> <workflow>` filter is a no-op when a parent
  // workflow such as /work owns the session).
  if (instruction && instruction.action === 'complete') {
    try {
      const { spawnSync } = require('child_process');
      const sessionGuardPath = path.join(__dirname, '..', 'lib', 'hooks', 'session-guard.js');
      spawnSync('node', [sessionGuardPath, 'complete', safeName, '/follow-up'], {
        stdio: 'inherit',
        timeout: 5000,
      });
    } catch {
      /* fail-open */
    }
  }

  console.log(JSON.stringify(instruction, null, 2));
}

if (require.main === module) main();

module.exports = { getNextInstruction };
