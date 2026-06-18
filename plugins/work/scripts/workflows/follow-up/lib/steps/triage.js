/**
 * Step: triage — Parse monitor output to determine next action.
 *
 * Priority order:
 *   1. Merge conflict → fix-ci
 *   2. CI FAILING → fix-ci
 *   3. CI PENDING → back to monitor (wait for CI to finish)
 *   4. CI CANCELLED + merge blocked → fix-ci
 *   5. CI CANCELLED + merge NOT blocked → treat as passing
 *   6. Blocking reviews with NO ongoing bot review → fix-reviews
 *   7. Ongoing bot review (awaiting) → back to monitor (wait for bot)
 *   8. All clear (CI passed, no reviews) → report
 */

'use strict';

function waitSeconds(seconds) {
  if (process.env.FOLLOW_UP2_NO_DELAY) return;
  const { execSync } = require('child_process');
  execSync(`node -e "setTimeout(()=>{},${seconds * 1000})"`, {
    timeout: (seconds + 5) * 1000,
  });
}

function buildBlocked(reason) {
  return { type: 'follow_up_instruction', action: 'blocked', reason };
}

// Unrecoverable guards: max polling attempts exhausted, or a monitor exit-2.
// Returns a blocked instruction, or null when neither applies.
function checkBlocked(state, result, output) {
  // Attempt is incremented only for wait-loops (pending CI, bot reviews)
  // not for actionable routes (fix-ci, fix-reviews, report).
  const maxAttempts = state.maxAttempts || 40;
  if ((state.attempt || 0) >= maxAttempts) {
    return buildBlocked(
      `Max polling attempts (${maxAttempts}) reached. CI still not resolved.\nLast status: ${output.substring(0, 300)}`
    );
  }
  if (result.exitCode === 2) {
    return buildBlocked(`Monitor error: ${output.substring(0, 500)}`);
  }
  return null;
}

// Parse the monitor output into the structured routing signals. Compound
// conditions are pre-computed here so routeTriage stays single-branch.
function extractSignals(output, state) {
  const hasBlockingReviews = /Reviews:.*BLOCKING/i.test(output);
  const hasOngoingReview = /awaiting bot reviews/i.test(output);
  const botStillRunning = /Cursor Bugbot.*running/i.test(output);
  const hasCiCancelled = /CI:\s*CANCELLED/i.test(output);
  const isMergeBlocked = /MERGE STATUS:\s*BLOCKED/i.test(output);
  return {
    // Structured signal `state._isConflicting` is set by monitor.js after a
    // bounded retry on `mergeable: UNKNOWN`; regex fallback covers older state
    // files written before this field existed.
    hasConflict: !!state._isConflicting || /merge conflict|cannot be merged/i.test(output),
    hasCiFailure: /CI:\s*FAILING/i.test(output),
    hasCiPending: /CI:\s*PENDING/i.test(output),
    hasBlockingReviews,
    hasOngoingReview,
    // Blocking reviews are actionable only once the bot has finished reviewing
    // (it may still dismiss old comments while running).
    reviewsActionable: hasBlockingReviews && !hasOngoingReview && !botStillRunning,
    reviewsWaiting: hasBlockingReviews && botStillRunning,
    ciCancelledBlocking: hasCiCancelled && isMergeBlocked && !hasBlockingReviews,
  };
}

// Adaptive CI-pending poll interval: shorter when few checks remain.
function ciPendingInterval(state) {
  const running = state._ciRunningCount || 0;
  if (running <= 2) return 15;
  if (state.attempt <= 5) return 30;
  return 60;
}

function bumpAttempt(state) {
  state.attempt = (state.attempt || 0) + 1;
}

function ongoingReviewInterval(state) {
  return state.attempt <= 5 ? 30 : 60;
}

// Wait, then route back to monitor for a fresh read. Returns null (advance).
function waitAndMonitor(state, seconds) {
  waitSeconds(seconds);
  state.currentStep = 'monitor';
  return null;
}

function routeTo(state, step, failureCategory) {
  if (failureCategory) state.failureCategory = failureCategory;
  state.currentStep = step;
  return null;
}

function routeTriage(state, signals) {
  // PRIORITY 0: conflict ALWAYS preempts everything else.
  if (signals.hasConflict) return routeTo(state, 'fix-ci', 'conflict');

  // Bug A (GH-508): route CI failures to infra-retry first. When its feature
  // flag is off, infra-retry falls through to fix-ci; routing to fix-ci
  // directly would skip infra-retry entirely when the flag is on.
  if (signals.hasCiFailure) return routeTo(state, 'infra-retry', 'ci_failure');

  // Blocking reviews take priority over waiting for CI.
  if (signals.reviewsActionable) return routeTo(state, 'fix-reviews', 'reviews');

  // Bot check still running with blocking reviews — wait for it to finish.
  if (signals.reviewsWaiting) {
    bumpAttempt(state);
    return waitAndMonitor(state, 15);
  }

  // CI still running — wait before re-checking.
  if (signals.hasCiPending) {
    bumpAttempt(state);
    return waitAndMonitor(state, ciPendingInterval(state));
  }

  // CI cancelled: only care if it blocks the merge.
  if (signals.ciCancelledBlocking) return routeTo(state, 'infra-retry', 'ci_cancelled_blocking');

  // Bot still reviewing — wait before re-checking.
  if (signals.hasOngoingReview) {
    bumpAttempt(state);
    return waitAndMonitor(state, ongoingReviewInterval(state));
  }

  // Only reach report when CI passed AND no blocking reviews.
  return routeTo(state, 'report');
}

module.exports = function registerTriage(register) {
  register('triage', (state) => {
    const result = state.lastMonitorResult || {};
    const output = result.output || '';

    const blocked = checkBlocked(state, result, output);
    if (blocked) return blocked;

    return routeTriage(state, extractSignals(output, state));
  });
};
