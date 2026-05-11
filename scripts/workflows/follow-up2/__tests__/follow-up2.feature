Feature: Follow-up2 PR monitoring and review handling

  Background:
    Given a ticket "GH-123" with PR #42
    And a tasks directory exists for "GH-123"

  # ─── Monitor Step ─────────────────────────────────────────────────────

  @integration
  Scenario: Monitor detects CI passing with no reviews
    Given follow-up-pr.js returns exit 0 with output "CI: PASSED (all 4 checks)\nReviews: CLEAR"
    When the monitor step runs
    Then state.lastMonitorResult.exitCode is 0
    And state.currentStep is set to "report"

  @integration
  Scenario: Monitor detects CI failing
    Given follow-up-pr.js returns exit 1 with output "CI: FAILING\n  ✗ Test (Node 20) — FAILED"
    When the monitor step runs
    Then state.lastMonitorResult.exitCode is 1
    And state.currentStep remains "monitor"

  @integration
  Scenario: Monitor detects blocking reviews
    Given follow-up-pr.js returns exit 1 with output "CI: PASSED\nReviews: 2 BLOCKING\n  ✗ @cursor[bot]"
    When the monitor step runs
    Then state.lastMonitorResult.exitCode is 1

  @integration
  Scenario: Monitor handles missing worktree gracefully
    Given the worktree directory does not exist
    When the monitor step runs
    Then it falls back to cwd instead of crashing

  # ─── Triage Step ──────────────────────────────────────────────────────

  @integration
  Scenario: Triage routes CI failure to fix-ci
    Given lastMonitorResult has exitCode 1 and output contains "CI: FAILING"
    When the triage step runs
    Then state.failureCategory is "ci_failure"
    And state.currentStep is "fix-ci"

  @integration
  Scenario: Triage routes merge conflict to fix-ci
    Given lastMonitorResult has exitCode 1 and output contains "merge conflict"
    When the triage step runs
    Then state.failureCategory is "conflict"
    And state.currentStep is "fix-ci"

  @integration
  Scenario: Triage routes blocking reviews to fix-reviews
    Given lastMonitorResult has exitCode 1 and output contains "Reviews: 2 BLOCKING"
    And output does not contain "awaiting bot reviews"
    When the triage step runs
    Then state.failureCategory is "reviews"
    And state.currentStep is "fix-reviews"

  @integration
  Scenario: Triage skips reviews when bot is still reviewing
    Given lastMonitorResult has exitCode 1 and output contains "Reviews: Awaiting bot reviews"
    When the triage step runs
    Then state.currentStep is "monitor"

  @integration
  Scenario: Triage loops back to monitor when CI is pending
    Given lastMonitorResult has exitCode 1 and output contains "CI: PENDING"
    When the triage step runs
    Then state.currentStep is "monitor"

  @integration
  Scenario: Triage treats CI cancelled as passing when merge not blocked
    Given lastMonitorResult has exitCode 1 and output contains "CI: CANCELLED"
    And output does not contain "MERGE STATUS: BLOCKED"
    When the triage step runs
    Then state.currentStep is "report"

  @integration
  Scenario: Triage routes CI cancelled to fix-ci when merge is blocked
    Given lastMonitorResult has exitCode 1 and output contains "CI: CANCELLED"
    And output contains "MERGE STATUS: BLOCKED"
    And output does not contain "Reviews: BLOCKING"
    When the triage step runs
    Then state.failureCategory is "ci_cancelled_blocking"
    And state.currentStep is "fix-ci"

  @integration
  Scenario: Triage returns blocked on monitor error (exit 2)
    Given lastMonitorResult has exitCode 2
    When the triage step runs
    Then it returns action "blocked"

  # ─── Fix-Reviews Step ─────────────────────────────────────────────────

  @integration
  Scenario: Fix-reviews surfaces snapshot errors instead of skipping
    Given the snapshot script fails with "Could not determine ticket ID"
    When the fix-reviews step runs
    Then it returns action "blocked" with the error message

  @integration
  Scenario: Fix-reviews shows one comment at a time with solve/skip commands
    Given the snapshot succeeds with 3 comments
    When the fix-reviews step runs
    Then it returns a delegate with "Review Comment 1 of 3"
    And the prompt includes "--solve-comment" command
    And the prompt includes "--skip-comment" command

  @integration
  Scenario: Fix-reviews blocks when all comments are skipped
    Given all comments are processed with 2 skipped
    When the fix-reviews step runs
    Then it returns action "blocked"
    And the reason mentions "skipped comments need your review"

  # ─── Push-Retry Step ──────────────────────────────────────────────────

  @integration
  Scenario: Push-retry skips when nothing to push
    Given git has no unpushed commits and no uncommitted changes
    When the push-retry step runs
    Then state.currentStep is "monitor"
    And no delegate is returned

  @integration
  Scenario: Push-retry emits git push when commits exist
    Given git has 2 unpushed commits
    When the push-retry step runs
    Then it returns a bash delegate with "git push"

  @integration
  Scenario: Push-retry blocks after max attempts
    Given state.attempt is 40 and state.maxAttempts is 40
    When the push-retry step runs
    Then it returns action "blocked"

  # ─── Orchestrator Loop ────────────────────────────────────────────────

  @e2e
  Scenario: Full flow — CI passes, no reviews
    Given follow-up-pr.js returns exit 0
    When follow-up-next.js runs for "GH-123"
    Then it returns action "complete"

  @e2e
  Scenario: Full flow — CI passes, reviews addressed
    Given follow-up-pr.js returns exit 1 with blocking reviews on first call
    And follow-up-pr.js returns exit 0 on second call
    When follow-up-next.js runs for "GH-123"
    Then it processes review comments before completing

  @e2e
  Scenario: Follow-up2 does NOT complete while CI is pending
    Given follow-up-pr.js returns exit 1 with "CI: PENDING"
    When follow-up-next.js runs for "GH-123"
    Then it does NOT return action "complete"
    And state.currentStep is "monitor"
