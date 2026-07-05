/**
 * Check dispatch-advance gate.
 *
 * Handles three cases:
 * 1. check2 reached a terminal state → verify the completion is SHA-fresh
 *    and the reports at the matching changes hash actually pass BEFORE
 *    advancing to PR (echo-5213-3 / echo-5804-004: the orchestrator used to
 *    advance past check purely on `.check2-state.json: status complete`,
 *    even when the cached reports still said NEEDS_WORK or the diff had
 *    changed since).
 *      - stale (hash/HEAD drift)   → re-dispatch /check2 (it auto-resets)
 *      - NEEDS_WORK at match hash  → REFUSE to advance (blocked)
 *      - valid                     → advance to pr
 * 2. check2 tests failed → transition back to implement
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ALL_STEPS } = require(path.join(__dirname, '..', '..', '..', 'work', 'step-registry'));
const { assessTerminalState } = require(
  path.join(__dirname, '..', '..', '..', 'check2', 'lib', 'staleness')
);

/**
 * @param {string} safeName
 * @param {object} ctx
 * @param {object} deps
 * @returns {null | { recurse: true } | object}
 */
function dispatchAdvanceGate(safeName, ctx, deps) {
  const { loadWorkState, saveWorkState, log, recursionDepth } = deps;

  const checkStatePath = path.join(ctx.tasksDir, '.check2-state.json');
  let checkState;
  try {
    checkState = JSON.parse(fs.readFileSync(checkStatePath, 'utf8'));
  } catch {
    return null;
  }

  const ws = loadWorkState(safeName);
  if (!ws) return null;

  // Case 1: check2 reached a terminal state → validate before advancing.
  if (checkState.status === 'complete' || checkState.status === 'needs_work') {
    // Compute the current SHAs inside the TICKET worktree (never the
    // orchestrator's cwd). deps.probes is a test-injection point.
    const probes = deps.probes || { cwd: ctx.worktreeDir };
    const assessment = assessTerminalState(checkState, ctx.tasksDir, probes);

    if (assessment.verdict === 'stale') {
      // Diff/HEAD changed since check2 completed — the completion no longer
      // covers the current code. Re-dispatch /check2; its SHA-gated reset
      // starts a fresh cycle automatically.
      ws.stepStatus.check = 'in_progress';
      delete ws._work2Dispatched;
      delete ws._work2DispatchedAction;
      saveWorkState(safeName, ws);
      if (log) {
        log.recurse(recursionDepth, `check re-dispatch (${assessment.reasons.join('; ')})`);
      }
      return { recurse: true };
    }

    if (assessment.verdict === 'needs_work' || checkState.status === 'needs_work') {
      // REFUSE to advance past check while the latest report at the matching
      // hash is NEEDS_WORK (echo-5213-3).
      const reasons =
        assessment.reasons.length > 0
          ? assessment.reasons
          : ['check2 state is needs_work at the current changes hash'];
      if (log) {
        log.error(`check→pr REFUSED: ${reasons.join('; ')}`);
      }
      return {
        type: 'work_instruction',
        action: 'blocked',
        state: { ...(ctx.stateCtx || {}), currentStep: 'check' },
        reason: `Cannot advance past check: ${reasons.join('; ')}.`,
        suggestion:
          'Fix the issues in the failing report(s) and commit. The next /check2 run detects ' +
          'the new changes hash and starts a fresh cycle — do NOT delete state files or reports.',
        reports: assessment.reports,
      };
    }

    // Valid: complete at the current hash with passing reports → advance to pr.
    ws.stepStatus.check = 'completed';
    ws.currentStep = ALL_STEPS.indexOf('pr') + 1;
    ws.stepStatus.pr = 'in_progress';
    delete ws._work2Dispatched;
    delete ws._work2DispatchedAction;
    saveWorkState(safeName, ws);

    if (log) {
      log.recurse(recursionDepth, 'check→pr (check2 complete)');
    }

    return { recurse: true };
  }

  // Case 2: tests failed → transition back to implement
  if (checkState.testsFailed) {
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
    saveWorkState(safeName, ws);

    if (log) {
      log.recurse(recursionDepth, 'check→implement (tests failed)');
    }

    return { recurse: true };
  }

  return null;
}

module.exports = { dispatchAdvanceGate };
