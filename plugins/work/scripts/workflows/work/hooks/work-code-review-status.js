#!/usr/bin/env node

/**
 * Stop hook to verify code-review reports don't have CRITICAL/IMPORTANT issues
 * that were incorrectly marked as APPROVED.
 *
 * This hook runs at the end of turns and checks:
 * 1. ONLY the current task's code-review.md (based on cwd or branch)
 * 2. If it contains CRITICAL or IMPORTANT issues
 * 3. If the summary incorrectly says APPROVED
 */

const fs = require('fs');
const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));
const {
  createBlockState,
  getCurrentTaskId,
  isRecentlyModified,
  loadStopHookConfig,
  readStdin,
  reviewDirsToCheck,
  shouldSkipCodexStop,
} = require(path.join(__dirname, '..', 'lib', 'stop-hook-utils'));
const { checkCodeReview, checkQaReport, findCodeReviewForTask, findQaReportsForTask } = require(
  path.join(__dirname, '..', 'lib', 'review-report-checks')
);

const blockState = createBlockState(__filename);

const config = loadStopHookConfig();
if (!config) process.exit(0);

// ─── Warning messages (byte-pinned — do not reword) ─────────────────────────

function criticalReplyWarning(taskId, issues) {
  return (
    `CODE REVIEW: CRITICAL ISSUES REQUIRE RESPONSE\n\n` +
    `Task: ${taskId}\n` +
    `File: ${taskId}/code-review.check.md\n\n` +
    `Report contains ${issues.criticalCount} CRITICAL issue(s)\n` +
    `No code-review-reply.check.md found\n\n` +
    `You MUST either:\n` +
    `1. Fix all CRITICAL issues in code, OR\n` +
    `2. Create code-review-reply.check.md with responses for each issue\n\n` +
    `Reply format for each issue:\n` +
    `  ## Issue: [title]\n` +
    `  **Decision:** FIXED | DEFERRED | NOT_APPLICABLE\n` +
    `  **Reason:** [specific justification]`
  );
}

function importantReplyWarning(taskId, issues) {
  return (
    `CODE REVIEW: IMPORTANT ISSUES REQUIRE RESPONSE\n\n` +
    `Task: ${taskId}\n` +
    `File: ${taskId}/code-review.check.md\n\n` +
    `Report contains ${issues.importantCount} IMPORTANT issue(s)\n` +
    `No code-review-reply.check.md found\n\n` +
    `You MUST either:\n` +
    `1. Fix all IMPORTANT issues in code, OR\n` +
    `2. Create code-review-reply.check.md with responses for each issue\n\n` +
    `Reply format for each issue:\n` +
    `  ## Issue: [title]\n` +
    `  **Decision:** FIXED | DEFERRED | NOT_APPLICABLE\n` +
    `  **Reason:** [specific justification]`
  );
}

function blockedTestsWarning(taskId) {
  return (
    `BLOCKED TESTS DETECTED\n\n` +
    `Task: ${taskId}\n` +
    `File: ${taskId}/code-review.check.md\n\n` +
    `Report contains BLOCKED tests\n` +
    `BLOCKED = FAIL, not PASS\n\n` +
    `Fix the blocking issue (likely Playwright MCP) and re-run /check.`
  );
}

function reviewExcuseWarning(taskId) {
  return (
    `QA REPORT CONTAINS FORBIDDEN EXCUSE\n\n` +
    `Task: ${taskId}\n` +
    `File: ${taskId}/code-review.check.md\n\n` +
    `Report uses a forbidden excuse to skip Playwright testing\n` +
    `"CI tests provide coverage" is NOT acceptable\n` +
    `"Deferred to automated tests" is NOT acceptable\n\n` +
    `QA MUST use Playwright browser tools - no exceptions.\n` +
    `Re-run /check with proper Playwright browser testing.`
  );
}

function qaExcuseWarning(taskId, fileName) {
  return (
    `QA REPORT CONTAINS FORBIDDEN EXCUSE\n\n` +
    `Task: ${taskId}\n` +
    `File: ${taskId}/${fileName}\n\n` +
    `Report uses a forbidden excuse to skip Playwright testing\n` +
    `"CI tests provide coverage" is NOT acceptable\n` +
    `"Playwright unavailable" is NOT acceptable without trying\n\n` +
    `QA MUST use Playwright browser tools - no exceptions.\n` +
    `Re-run /check with proper Playwright browser testing.`
  );
}

function qaPlaywrightWarning(taskId, fileName) {
  return (
    `QA REPORT MISSING PLAYWRIGHT VERIFICATION\n\n` +
    `Task: ${taskId}\n` +
    `File: ${taskId}/${fileName}\n\n` +
    `Report claims PASS but has no Playwright verification\n` +
    `Missing "## Playwright Verification" section\n\n` +
    `QA reports MUST include Playwright verification showing:\n` +
    `- mcp__playwright__browser_navigate call\n` +
    `- Result: SUCCESS with page title\n\n` +
    `Re-run /check with proper Playwright browser testing.`
  );
}

function qaConnectivityWarning(taskId, fileName) {
  return (
    `QA REPORT MISSING CONNECTIVITY VERIFICATION\n\n` +
    `Task: ${taskId}\n` +
    `File: ${taskId}/${fileName}\n\n` +
    `Report is MISSING mandatory connectivity verification\n` +
    `Must include "## Playwright Connectivity Verification" section\n\n` +
    `QA reports MUST include:\n` +
    `1. External Connectivity (google.com) - test with screenshot\n` +
    `2. App Health Check - test with screenshot\n\n` +
    `This proves Playwright actually works BEFORE claiming any result.\n` +
    `Re-run /check - QA agent MUST call mcp__playwright__browser_navigate\n` +
    `on google.com FIRST, then on app health endpoint.`
  );
}

function qaHealthWarning(taskId, fileName) {
  return (
    `QA REPORT MISSING APP HEALTH CHECK\n\n` +
    `Task: ${taskId}\n` +
    `File: ${taskId}/${fileName}\n\n` +
    `External connectivity (google.com) verified\n` +
    `But App Health Check is missing\n\n` +
    `QA reports MUST include App Health Check showing:\n` +
    `- Navigate to app URL/health or app URL\n` +
    `- Screenshot of the health check result\n\n` +
    `Re-run /check with app health verification.`
  );
}

// ─── Collection ──────────────────────────────────────────────────────────────

// Check for violations - CRITICAL/IMPORTANT issues MUST have reply file
function pushReviewWarnings(warnings, taskId, issues, hasReplyFile) {
  if (issues.hasCritical && !hasReplyFile) {
    warnings.push(criticalReplyWarning(taskId, issues));
  }

  // IMPORTANT issues also need reply file
  if (issues.hasImportant && !hasReplyFile) {
    warnings.push(importantReplyWarning(taskId, issues));
  }

  if (issues.hasBlocked) {
    warnings.push(blockedTestsWarning(taskId));
  }

  if (issues.hasForbiddenExcuse) {
    warnings.push(reviewExcuseWarning(taskId));
  }
}

function collectCodeReviewWarnings(dirsToCheck, taskId) {
  const warnings = [];
  for (const dir of dirsToCheck) {
    // Only check the CURRENT task's code-review.md
    const filePath = findCodeReviewForTask(config, dir, taskId);
    if (!filePath) continue;

    // Only check recently modified files
    if (!isRecentlyModified(filePath)) continue;

    const issues = checkCodeReview(filePath);
    if (!issues) continue;

    // Check if reply file exists
    const replyPath = path.join(path.dirname(filePath), 'code-review-reply.check.md');
    pushReviewWarnings(warnings, taskId, issues, fs.existsSync(replyPath));
  }
  return warnings;
}

function pushQaWarnings(warnings, taskId, fileName, qaIssues) {
  // Check for forbidden excuses in QA report
  if (qaIssues.hasForbiddenExcuse) {
    warnings.push(qaExcuseWarning(taskId, fileName));
  }

  // Check for missing Playwright verification when claiming PASS
  if (qaIssues.claimsPass && !qaIssues.hasPlaywrightVerification) {
    warnings.push(qaPlaywrightWarning(taskId, fileName));
  }

  // Check for missing CONNECTIVITY verification section (NEW - MANDATORY)
  if (!qaIssues.hasConnectivityVerification && !qaIssues.hasGoogleTest) {
    warnings.push(qaConnectivityWarning(taskId, fileName));
  }

  // Check for missing health check specifically
  if (qaIssues.hasGoogleTest && !qaIssues.hasHealthCheck) {
    warnings.push(qaHealthWarning(taskId, fileName));
  }
}

// Check QA reports for Playwright verification
function collectQaWarnings(dirsToCheck, taskId) {
  const warnings = [];
  for (const dir of dirsToCheck) {
    for (const qaFile of findQaReportsForTask(config, dir, taskId)) {
      if (!isRecentlyModified(qaFile)) continue;

      const qaIssues = checkQaReport(qaFile);
      if (!qaIssues) continue;

      pushQaWarnings(warnings, taskId, path.basename(qaFile), qaIssues);
    }
  }
  return warnings;
}

async function main() {
  const input = await readStdin();
  const hookData = JSON.parse(input);

  if (shouldSkipCodexStop(hookData)) {
    process.exit(0);
  }

  const cwd = process.cwd();

  // Get current task ID
  const currentTaskId = getCurrentTaskId(config, cwd);

  if (!currentTaskId) {
    // Not working on a specific task - approve
    process.exit(0);
  }

  // Check directories for the current task's report
  const dirsToCheck = reviewDirsToCheck(config, cwd);

  const warnings = [
    ...collectCodeReviewWarnings(dirsToCheck, currentTaskId),
    ...collectQaWarnings(dirsToCheck, currentTaskId),
  ];

  if (warnings.length > 0) {
    process.stderr.write(warnings.join('\n\n---\n\n') + '\n');
    blockState.didBlock = true;
    process.exit(2);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  logHookError(__filename, err);
  process.exit(blockState.didBlock ? 2 : 0);
});
