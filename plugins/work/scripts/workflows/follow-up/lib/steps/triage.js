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

module.exports = function registerTriage(register) {
  register('triage', (state) => {
    const result = state.lastMonitorResult || {};
    const output = result.output || '';

    // Max attempts guard — prevent infinite polling
    // Attempt is incremented only for wait-loops (pending CI, bot reviews)
    // not for actionable routes (fix-ci, fix-reviews, report)
    const maxAttempts = state.maxAttempts || 40;
    if ((state.attempt || 0) >= maxAttempts) {
      return {
        type: 'follow_up_instruction',
        action: 'blocked',
        reason: `Max polling attempts (${maxAttempts}) reached. CI still not resolved.\nLast status: ${output.substring(0, 300)}`,
      };
    }

    // Error (exit 2) — unrecoverable
    if (result.exitCode === 2) {
      return {
        type: 'follow_up_instruction',
        action: 'blocked',
        reason: `Monitor error: ${output.substring(0, 500)}`,
      };
    }

    // ── PRIORITY 0: merge conflict ──────────────────────────────────────
    // Conflict ALWAYS preempts everything else (CI status, reviews, etc).
    // Structured signal `state._isConflicting` is set by monitor.js after
    // a bounded retry on `mergeable: UNKNOWN`, so it survives the case
    // where formatReport didn't emit a "CONFLICTS:" line yet (e.g. when
    // GitHub was mid-recompute). Regex fallback covers older state files
    // written before this field existed.
    const structuredConflict = !!state._isConflicting;
    const hasConflict = structuredConflict || /merge conflict|cannot be merged/i.test(output);
    if (hasConflict) {
      state.failureCategory = 'conflict';
      state.currentStep = 'fix-ci';
      return null;
    }

    const hasCiFailure = /CI:\s*FAILING/i.test(output);
    const hasCiPending = /CI:\s*PENDING/i.test(output);
    const hasCiCancelled = /CI:\s*CANCELLED/i.test(output);
    const isMergeBlocked = /MERGE STATUS:\s*BLOCKED/i.test(output);
    const hasBlockingReviews = /Reviews:.*BLOCKING/i.test(output);
    const hasOngoingReview = /awaiting bot reviews/i.test(output);

    if (hasCiFailure) {
      state.failureCategory = 'ci_failure';
      // Bug A (GH-508): route CI failures to infra-retry first. infra-retry's
      // shouldBypass returns null (advance to fix-ci) when the feature flag is
      // off, so the loop naturally falls through to fix-ci. Routing to fix-ci
      // directly would skip infra-retry entirely when the flag is on.
      state.currentStep = 'infra-retry';
      return null;
    }

    // Blocking reviews take priority over waiting for CI —
    // but only when the bot has finished reviewing (check completed).
    // While the bot check is still running, it may dismiss old comments.
    const botStillRunning = /Cursor Bugbot.*running/i.test(output);
    if (hasBlockingReviews && !hasOngoingReview && !botStillRunning) {
      state.failureCategory = 'reviews';
      state.currentStep = 'fix-reviews';
      return null;
    }

    // Bot check still running with blocking reviews — wait for it to finish
    if (hasBlockingReviews && botStillRunning) {
      state.attempt = (state.attempt || 0) + 1;
      waitSeconds(15);
      state.currentStep = 'monitor';
      return null;
    }

    // CI still running — wait before re-checking.
    // Adaptive interval: shorter when few checks remain.
    if (hasCiPending) {
      state.attempt = (state.attempt || 0) + 1;
      const running = state._ciRunningCount || 0;
      let interval = 60;
      if (running <= 2) interval = 15;
      else if (state.attempt <= 5) interval = 30;
      waitSeconds(interval);
      state.currentStep = 'monitor';
      return null;
    }

    // CI cancelled: only care if it blocks the merge
    if (hasCiCancelled && isMergeBlocked && !hasBlockingReviews) {
      state.failureCategory = 'ci_cancelled_blocking';
      // Bug A (GH-508): same as ci_failure — visit infra-retry first.
      state.currentStep = 'infra-retry';
      return null;
    }

    // Bot still reviewing — wait before re-checking
    if (hasOngoingReview) {
      state.attempt = (state.attempt || 0) + 1;
      const interval = state.attempt <= 5 ? 30 : 60;
      waitSeconds(interval);
      state.currentStep = 'monitor';
      return null;
    }

    // Only reach report when CI passed AND no blocking reviews
    state.currentStep = 'report';
    return null;
  });
};
