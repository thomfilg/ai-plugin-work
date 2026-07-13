/**
 * Check dispatch-advance gate.
 *
 * Handles three cases:
 * 1. check reached a terminal state → verify the completion is SHA-fresh
 *    and the reports at the matching changes hash actually pass BEFORE
 *    advancing to PR (echo-5213-3 / echo-5804-004: the orchestrator used to
 *    advance past check purely on `.check2-state.json: status complete`,
 *    even when the cached reports still said NEEDS_WORK or the diff had
 *    changed since).
 *      - stale (hash/HEAD drift)   → re-dispatch /check (it auto-resets)
 *      - NEEDS_WORK at match hash  → REFUSE to advance (blocked)
 *      - valid                     → advance to pr
 * 2. check tests failed → transition back to implement
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ALL_STEPS } = require(path.join(__dirname, '..', '..', '..', 'work', 'step-registry'));
const { assessTerminalState, recordCompletion } = require(
  path.join(__dirname, '..', '..', '..', 'check', 'lib', 'staleness')
);

/**
 * Diff/HEAD changed since check completed — the completion no longer
 * covers the current code. Re-dispatch /check; its SHA-gated reset
 * starts a fresh cycle automatically.
 */
function redispatchStaleCheck(gate, ws, assessment) {
  const { safeName, deps } = gate;
  ws.stepStatus.check = 'in_progress';
  delete ws._work2Dispatched;
  delete ws._work2DispatchedAction;
  deps.saveWorkState(safeName, ws);
  if (deps.log) {
    deps.log.recurse(deps.recursionDepth, `check re-dispatch (${assessment.reasons.join('; ')})`);
  }
  return { recurse: true };
}

/**
 * REFUSE to advance past check while the latest report at the matching
 * hash is NEEDS_WORK (echo-5213-3).
 */
function refuseNeedsWork(gate, assessment) {
  const { ctx, deps } = gate;
  const reasons =
    assessment.reasons.length > 0
      ? assessment.reasons
      : ['check state is needs_work at the current changes hash'];
  if (deps.log) {
    deps.log.error(`check→pr REFUSED: ${reasons.join('; ')}`);
  }
  return {
    type: 'work_instruction',
    action: 'blocked',
    state: { ...(ctx.stateCtx || {}), currentStep: 'check' },
    reason: `Cannot advance past check: ${reasons.join('; ')}.`,
    suggestion:
      'Fix the issues in the failing report(s) and commit. The next /check run detects ' +
      'the new changes hash and starts a fresh cycle — do NOT delete state files or reports.',
    reports: assessment.reports,
  };
}

/**
 * When the stored status is still 'needs_work' (reports re-written APPROVED
 * at the same hash) promote the check state file so the record matches —
 * the mirror of check-next.js answerStillValid's promotion (livelock fix,
 * PR #669 review).
 */
function promoteNeedsWorkRecord(gate, checkState, assessment) {
  if (checkState.status !== 'needs_work') return;
  checkState.status = 'complete';
  recordCompletion(checkState, { currentHead: assessment.currentHead });
  try {
    fs.writeFileSync(gate.checkStatePath, JSON.stringify(checkState, null, 2));
  } catch {
    /* best-effort — the advance below is the authoritative outcome */
  }
}

/** Valid: passing reports at the current hash → advance to pr. */
function advanceCheckToPr(gate, ws) {
  const { safeName, deps } = gate;
  ws.stepStatus.check = 'completed';
  ws.currentStep = ALL_STEPS.indexOf('pr') + 1;
  ws.stepStatus.pr = 'in_progress';
  delete ws._work2Dispatched;
  delete ws._work2DispatchedAction;
  deps.saveWorkState(safeName, ws);

  if (deps.log) {
    deps.log.recurse(deps.recursionDepth, 'check→pr (check complete)');
  }

  return { recurse: true };
}

/** Case 1: check reached a terminal state → validate before advancing. */
function handleTerminalState(gate, checkState, ws) {
  // Compute the current SHAs inside the TICKET worktree (never the
  // orchestrator's cwd). deps.probes is a test-injection point.
  const probes = gate.deps.probes || { cwd: gate.ctx.worktreeDir };
  const assessment = assessTerminalState(checkState, gate.ctx.tasksDir, probes);

  if (assessment.verdict === 'stale') return redispatchStaleCheck(gate, ws, assessment);
  if (assessment.verdict === 'needs_work') return refuseNeedsWork(gate, assessment);

  promoteNeedsWorkRecord(gate, checkState, assessment);
  return advanceCheckToPr(gate, ws);
}

/** Case 2: tests failed → transition back to implement. */
function handleTestsFailed(gate, ws) {
  const { safeName, checkStatePath, deps } = gate;
  try {
    fs.unlinkSync(checkStatePath);
  } catch {
    /* fail-open */
  }

  ws.stepStatus.check = 'pending';
  ws.stepStatus.commit = 'pending';
  ws.stepStatus.task_review = 'pending';
  ws.stepStatus.implement = 'in_progress';
  ws.currentStep = ALL_STEPS.indexOf('implement') + 1;
  delete ws._work2Dispatched;
  delete ws._work2DispatchedAction;
  deps.saveWorkState(safeName, ws);

  if (deps.log) {
    deps.log.recurse(deps.recursionDepth, 'check→implement (tests failed)');
  }

  return { recurse: true };
}

/**
 * @param {string} safeName
 * @param {object} ctx
 * @param {object} deps
 * @returns {null | { recurse: true } | object}
 */
function dispatchAdvanceGate(safeName, ctx, deps) {
  // Canonical state file, falling back to the legacy .check2-state.json name
  // for in-flight tickets that predate the check2 → check rename.
  let checkStatePath = path.join(ctx.tasksDir, '.check-state.json');
  if (!fs.existsSync(checkStatePath)) {
    const legacyPath = path.join(ctx.tasksDir, '.check2-state.json');
    if (fs.existsSync(legacyPath)) checkStatePath = legacyPath;
  }
  let checkState;
  try {
    checkState = JSON.parse(fs.readFileSync(checkStatePath, 'utf8'));
  } catch {
    return null;
  }

  const ws = deps.loadWorkState(safeName);
  if (!ws) return null;

  const gate = { safeName, ctx, deps, checkStatePath };

  // Case 1: check reached a terminal state → validate before advancing.
  if (checkState.status === 'complete' || checkState.status === 'needs_work') {
    return handleTerminalState(gate, checkState, ws);
  }

  // Case 2: tests failed → transition back to implement
  if (checkState.testsFailed) {
    return handleTestsFailed(gate, ws);
  }

  return null;
}

module.exports = { dispatchAdvanceGate };
