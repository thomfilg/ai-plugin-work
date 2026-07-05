#!/usr/bin/env node

/**
 * follow-up-next.js — Script-driven orchestrator for /follow-up.
 *
 * Outputs a SINGLE instruction. Auto-advance hook calls this after each step.
 *
 * IMPORTANT: No step-specific logic here. Steps live in lib/steps/.
 *
 * Usage: node follow-up-next.js <TICKET_ID> [--pr N] [--init]
 *
 * Flags:
 *   --pr N   Pin the PR number (skips discovery).
 *   --init   Drop cached state and start a fresh follow-up cycle. Use at
 *            first-run bootstrap OR after manually fixing an infra-shaped
 *            failure (gh auth, network, VPN) so the next monitor run
 *            executes against fresh inputs instead of re-emitting a stale
 *            cached failure. Note: the monitor step also auto-clears
 *            stale infra failures (see lib/infra-patterns.js); --init is
 *            still required for non-infra cached failures.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { detectDefaultBranch, loadPrDiffFiles } = require('./lib/repo-meta');
const { buildClassifierCtx } = require('./lib/classifier-ctx');

if (require.main === module) {
  require('../lib/instruction-guards').installInstructionGuards('follow_up_instruction');
}

// ─── Resolve paths ──────────────────────────────────────────────────────────
const { resolvePluginConfig } = require('../lib/plugin-config');
const { libDir, WORKTREES_BASE, TASKS_BASE } = resolvePluginConfig(
  path.join(__dirname, '..', 'work')
);
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
const { runStep, STEPS, dispatchStepResult } = require(
  path.join(__dirname, 'lib', 'step-registry')
);
const { isInfraFailure, isStale } = require(path.join(__dirname, 'lib', 'infra-patterns'));

// ─── State management ───────────────────────────────────────────────────────

const { loadState, saveState, initState, initFreshState } =
  require('./lib/follow-up-state')(TASKS_BASE);

// ─── Core orchestrator loop ─────────────────────────────────────────────────

// Re-verify a saved "complete"/invalid-step state against live GitHub before
// honoring it. The saved state is a cache of a prior run's decision; if
// anything changed (new pushes, checks now running, merge state now blocked)
// we must NOT silently return "Already complete" — that's how PR #1929 cleared
// its session guard with 9 in-progress checks and 2 unpushed commits.
//
// Returns { loop: true } to rewind+continue, or { result } to return.
function reconcileSavedComplete(state, ticketId) {
  if (state.prNumber) {
    let actionable = false;
    let realBlockers = [];
    try {
      const { assessMergeable, hasActionableBlockers } = require(
        path.join(__dirname, '..', 'work', 'lib', 'pr-mergeable.js')
      );
      // hasActionableBlockers centralises the two guards (filter out gh_error
      // transients, require prState=OPEN) shared with ci-gate.js.
      const action = hasActionableBlockers(assessMergeable(state.prNumber));
      actionable = action.actionable;
      realBlockers = action.realBlockers;
    } catch {
      actionable = false;
    }
    if (actionable) {
      const blockerSummary = realBlockers.map((b) => b.kind).join(', ');
      process.stderr.write(
        `[follow-up-next] saved state said complete but PR #${state.prNumber} is not mergeable (${blockerSummary}); rewinding and resuming.\n`
      );
      state.status = 'in_progress';
      // Always rewind to 'monitor' (the live CI-rollup read). Hardcoded rather
      // than STEPS[0] so a future reorder of the step registry can't silently
      // rewind to whatever happens to be first.
      state.currentStep = 'monitor';
      state.dispatched = null;
      saveState(ticketId, state);
      return { loop: true };
    }
  }
  saveState(ticketId, state);
  return {
    result: { type: 'follow_up_instruction', action: 'complete', summary: 'Already complete.' },
  };
}

// Auto-clear stale infra-failure cache before ANY step runs (GH-536 #551
// round-2 fix). The monitor step's own clearStaleInfraCache only fires when the
// workflow re-enters monitor — but triage blocks on exitCode 2 without
// advancing, so subsequent runs only re-execute triage and the cache is never
// invalidated. Lifting the check here ensures downstream steps (triage, fix-ci,
// report) also benefit and route the flow back to monitor for a fresh run.
// Returns true when it rewound to monitor (caller should `continue`).
function maybeClearStaleInfra(state, ticketId) {
  const cached = state.lastMonitorResult;
  if (cached && isInfraFailure(cached.output || '') && isStale(state.lastMonitorAt)) {
    delete state.lastMonitorResult;
    delete state.lastMonitorAt;
    // Rewind to 'monitor' explicitly — see rationale above.
    state.currentStep = 'monitor';
    state.dispatched = null;
    saveState(ticketId, state);
    return true;
  }
  return false;
}

// action:'surface' is terminal (spec API/Interface Changes — GH-508). Mutate
// state to route to report and attach a diagnostic summary, but do NOT mark
// status='complete' so the next /follow-up invocation resumes from a live
// re-evaluation rather than the cache.
// The reason may live on the top-level result (legacy shape) or under
// result.payload.reason (newer shape).
function surfaceReasonOf(result) {
  return (result.payload && result.payload.reason) || result.reason || null;
}

function summaryOf(reportResult) {
  if (!reportResult) return null;
  return reportResult.summary || (reportResult.payload && reportResult.payload.summary) || null;
}

function applySurface(result, state, ctx) {
  state.currentStep = 'report';
  // Persist the surface reason as a failureCategory so the next /follow-up
  // cycle's report step recognises the workflow is still stuck and does NOT
  // mark status=complete.
  const reason = surfaceReasonOf(result);
  if (reason) state.failureCategory = reason;

  // Bug 542-10: build the diagnostic summary BEFORE returning so the
  // auto-advance hook (which treats `surface` as terminal) shows the
  // per-attempt GitHub Actions URLs without requiring a second invocation.
  try {
    const summary = summaryOf(runStep('report', state, ctx));
    if (summary) result.payload = Object.assign({}, result.payload || {}, { summary });
  } catch (_e) {
    /* fail open — surface still terminal; user can re-run /follow-up */
  }
}

// A step returned null → advance. Returns { loop: true } when the step set its
// own currentStep (looping), or { result } on workflow completion, or
// { loop: true } after advancing to the next step.
function advanceStep(state, ticketId, stepIdx) {
  // Step changed currentStep (e.g., triage → fix-ci, or push-retry → monitor)
  if (state.currentStep !== STEPS[stepIdx]) {
    state.dispatched = null;
    saveState(ticketId, state);
    return { loop: true };
  }

  const nextIdx = stepIdx + 1;
  if (nextIdx >= STEPS.length) {
    state.status = 'complete';
    saveState(ticketId, state);
    return {
      result: {
        type: 'follow_up_instruction',
        action: 'complete',
        summary: `Follow-up complete for ${ticketId}.`,
      },
    };
  }

  state.currentStep = STEPS[nextIdx];
  state.dispatched = null;
  saveState(ticketId, state);
  return { loop: true };
}

function loadOrInitState(ticketId, prNumber) {
  const state = loadState(ticketId) || initState(ticketId, prNumber);
  if (prNumber && !state.prNumber) state.prNumber = prNumber;
  return state;
}

function isTerminalState(state) {
  return state.status === 'complete' || !STEPS.includes(state.currentStep);
}

// Run a single orchestrator iteration. Returns { loop: true } to continue the
// loop, or { result } to return that instruction to the caller.
function stepOnce(state, ticketId, ctx) {
  if (isTerminalState(state)) return reconcileSavedComplete(state, ticketId);
  if (maybeClearStaleInfra(state, ticketId)) return { loop: true };

  const stepIdx = STEPS.indexOf(state.currentStep);
  const result = runStep(state.currentStep, state, ctx);
  if (result) {
    if (result.action === 'surface') applySurface(result, state, ctx);
    saveState(ticketId, state);
    return { result };
  }
  return advanceStep(state, ticketId, stepIdx);
}

function getNextInstruction(ticketId, prNumber) {
  const state = loadOrInitState(ticketId, prNumber);

  const tasksDir = path.join(TASKS_BASE, ticketId);
  const candidateWorktree = path.join(WORKTREES_BASE, `${MAIN_WORKTREE_FOLDER}-${ticketId}`);
  const worktreeDir = fs.existsSync(candidateWorktree) ? candidateWorktree : process.cwd();

  // PR #542 cursor[bot]: monitor mutates state._ciAllJobs / _ciFailedLogs /
  // _ciStatus mid-loop, so a ctx built once before the loop hands a stale
  // snapshot to a later step (e.g. infra-retry). Rebuild ctx fresh on every
  // iteration so subsequent steps observe the post-monitor state.
  const freshCtx = () => ({
    tasksDir,
    worktreeDir,
    TASKS_BASE,
    workScriptsDir: path.join(__dirname, '..', 'work', 'scripts'),
    ...buildClassifierCtx(state, worktreeDir),
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const outcome = stepOnce(state, ticketId, freshCtx());
    if (outcome.loop) continue;
    return outcome.result;
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

// Terminal states used to leave only a JSON blob in the transcript — ping
// the operator mailbox + terminal bell so a blocked/complete follow-up is
// never silent ("agents get stuck with no notifications").
function notifyTerminalInstruction(instruction, safeName) {
  if (!instruction || !['blocked', 'surface', 'complete'].includes(instruction.action)) return;
  try {
    const { notifyOperator } = require('./lib/notify');
    const detail =
      instruction.summary ||
      instruction.reason ||
      (instruction.payload && instruction.payload.reason) ||
      '';
    notifyOperator(safeName, `${instruction.action}: ${String(detail).split('\n')[0]}`);
  } catch {
    /* fail-open — notification is best-effort */
  }
}

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
    const { ownerStamp } = require(path.join(__dirname, '..', 'work', 'lib', 'marker'));
    fs.writeFileSync(
      path.join(markerDir, '.follow-up-orchestrator.pid'),
      JSON.stringify({
        ticket: safeName,
        startedAt: new Date().toISOString(),
        workflow: '/follow-up',
        ...ownerStamp(),
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

  notifyTerminalInstruction(instruction, safeName);

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

module.exports = {
  getNextInstruction,
  initState,
  initFreshState,
  dispatchStepResult,
  __test__: {
    initState,
    detectDefaultBranch,
    loadPrDiffFiles,
  },
};
