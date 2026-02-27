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
const { execSync } = require('child_process');
const config = require('../lib/config');

// Get current task ID from cwd or git branch
function getCurrentTaskId(cwd) {
  // Try to get from worktree folder name (e.g., ${config.REPO_NAME}-${jira_task_id})
  const worktreeMatch = cwd.match(new RegExp(`${config.JIRA_PROJECT_KEY}-(\\d+)`, 'i'));
  if (worktreeMatch) {
    return `${config.JIRA_PROJECT_KEY}-${worktreeMatch[1]}`;
  }

  // Try to get from git branch name
  try {
    const branch = execSync('git branch --show-current', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    const branchMatch = branch.match(new RegExp(`${config.JIRA_PROJECT_KEY}-(\\d+)`, 'i'));
    if (branchMatch) {
      return `${config.JIRA_PROJECT_KEY}-${branchMatch[1]}`;
    }
  } catch {
    // Ignore git errors
  }

  return null;
}

// Find code-review.check.md for a specific task
function findCodeReviewForTask(baseDir, taskId) {
  if (!taskId) return null;

  const tasksDir = path.join(baseDir, 'tasks');
  const taskFolder = path.join(tasksDir, taskId);
  const reviewFile = path.join(taskFolder, 'code-review.check.md');

  if (fs.existsSync(reviewFile)) {
    return reviewFile;
  }

  return null;
}

// Find QA reports for a specific task
function findQaReportsForTask(baseDir, taskId) {
  if (!taskId) return [];

  const tasksDir = path.join(baseDir, 'tasks');
  const taskFolder = path.join(tasksDir, taskId);

  if (!fs.existsSync(taskFolder)) return [];

  const files = fs.readdirSync(taskFolder);
  return files
    .filter(f => f.startsWith('qa') && f.endsWith('.check.md'))
    .map(f => path.join(taskFolder, f));
}

// Check QA report for Playwright verification
function checkQaReport(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const issues = {
      hasPlaywrightVerification: false,
      hasConnectivityVerification: false,
      hasGoogleTest: false,
      hasHealthCheck: false,
      hasScreenshots: false,
      hasForbiddenExcuse: false,
      claimsPass: false
    };

    // Check for NEW Connectivity Verification section (MANDATORY)
    if (/##\s*Playwright\s*Connectivity\s*Verification/i.test(content)) {
      issues.hasConnectivityVerification = true;
    }

    // Check for google.com test
    if (/###\s*External\s*Connectivity\s*\(google\.com\)/i.test(content)) {
      issues.hasGoogleTest = true;
    }
    // Alternative: check for google.com URL with status
    if (/google\.com.*Status:\s*(✅|SUCCESS|FAILED|❌)/i.test(content) ||
        /Status:.*google\.com/i.test(content)) {
      issues.hasGoogleTest = true;
    }

    // Check for app health check
    if (/###\s*App\s*Health\s*Check/i.test(content)) {
      issues.hasHealthCheck = true;
    }
    // Alternative: check for health endpoint or app URL with status
    if (/\/health.*Status:\s*(✅|SUCCESS|FAILED|❌)/i.test(content) ||
        /host\.docker\.internal.*Status:/i.test(content)) {
      issues.hasHealthCheck = true;
    }

    // Check for Playwright Verification section (old check, still valid)
    if (/##\s*Playwright\s*Verification/i.test(content)) {
      issues.hasPlaywrightVerification = true;
    }

    // Check for actual Playwright tool calls in report
    if (/mcp__playwright__browser_navigate/i.test(content) && /Result:\s*(SUCCESS|Page loaded)/i.test(content)) {
      issues.hasPlaywrightVerification = true;
    }

    // Check for screenshots
    if (/!\[.*\]\(.*\.png\)/i.test(content) || /screenshots?\//i.test(content)) {
      issues.hasScreenshots = true;
    }

    // Check for forbidden excuses
    const forbiddenExcuses = [
      /CI\s*(e2e|tests?)\s*provide\s*coverage/i,
      /deferred\s*to\s*(automated|CI)\s*tests/i,
      /API\s*tests?\s*(are|is)\s*sufficient/i,
      /browser\s*testing\s*not\s*needed/i,
      /screenshots?\s*not\s*required/i,
      /didn'?t\s*use\s*Playwright/i,
      /Playwright\s*not\s*used/i,
      /Playwright\s*(MCP\s*)?tools?\s*unavailable/i,
      /skipped\s*browser\s*test/i
    ];

    for (const pattern of forbiddenExcuses) {
      if (pattern.test(content)) {
        issues.hasForbiddenExcuse = true;
        break;
      }
    }

    // Check if claims PASS
    if (/Status:\s*PASS|✅\s*PASS|All\s*tests?\s*pass/i.test(content)) {
      issues.claimsPass = true;
    }

    return issues;
  } catch {
    return null;
  }
}

// Check if file was modified in last 10 minutes
function isRecentlyModified(filePath) {
  try {
    const stats = fs.statSync(filePath);
    const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
    return stats.mtimeMs > tenMinutesAgo;
  } catch {
    return false;
  }
}

// Parse code-review.md for issues
function checkCodeReview(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    const issues = {
      hasCritical: false,
      hasImportant: false,
      hasBlocked: false,
      claimsApproved: false,
      criticalCount: 0,
      importantCount: 0
    };

    // Check for CRITICAL issues - but verify they're actual issues, not just headers
    // Look for patterns like "### CRITICAL" or "🔴 CRITICAL" followed by actual content
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check for CRITICAL section
      if (/CRITICAL/i.test(line) && /###|🔴|\*\*/.test(line)) {
        // Check next few lines to see if there are actual issues
        const nextLines = lines.slice(i + 1, i + 5).join(' ').toLowerCase();

        // If next lines say "none found", "no critical", "0 issues" - skip
        if (/none\s*found|no\s*critical|no\s*issues|0\s*issues|\*\*0\*\*|:\s*0($|\s)/i.test(nextLines)) {
          continue;
        }

        // If there's actual content (numbered list, bullet points, etc.)
        if (/^\s*[-*\d]/.test(lines[i + 1] || '') || /^\s*[-*\d]/.test(lines[i + 2] || '')) {
          issues.hasCritical = true;
          issues.criticalCount++;
        }
      }

      // Check for IMPORTANT section
      if (/IMPORTANT/i.test(line) && /###|🟡|\*\*/.test(line)) {
        // Check next few lines to see if there are actual issues
        const nextLines = lines.slice(i + 1, i + 5).join(' ').toLowerCase();

        // If next lines say "none found", "no important", "0 issues" - skip
        if (/none\s*found|no\s*important|no\s*issues|0\s*issues|\*\*0\*\*|:\s*0($|\s)/i.test(nextLines)) {
          continue;
        }

        // If there's actual content (numbered list, bullet points, etc.)
        if (/^\s*[-*\d]/.test(lines[i + 1] || '') || /^\s*[-*\d]/.test(lines[i + 2] || '')) {
          issues.hasImportant = true;
          issues.importantCount++;
        }
      }
    }

    // Also check for inline critical/important issue markers
    const criticalInlineMatches = content.match(/🔴\s*CRITICAL[^#\n]*:/gi) || [];
    const importantInlineMatches = content.match(/🟡\s*IMPORTANT[^#\n]*:/gi) || [];

    if (criticalInlineMatches.length > 0) {
      issues.hasCritical = true;
      issues.criticalCount = Math.max(issues.criticalCount, criticalInlineMatches.length);
    }

    if (importantInlineMatches.length > 0) {
      issues.hasImportant = true;
      issues.importantCount = Math.max(issues.importantCount, importantInlineMatches.length);
    }

    // Check for BLOCKED tests (but not "0 BLOCKED" or "BLOCKED: 0")
    if (/BLOCKED/i.test(content)) {
      // Make sure it's not "0 BLOCKED" or "BLOCKED: 0" or "no blocked"
      if (!/0\s*BLOCKED|BLOCKED\s*:\s*0|no\s*blocked|none\s*blocked/i.test(content)) {
        // Check if there's a number before BLOCKED (like "2 BLOCKED")
        const blockedMatch = content.match(/(\d+)\s*BLOCKED/i);
        if (blockedMatch && parseInt(blockedMatch[1]) > 0) {
          issues.hasBlocked = true;
        } else if (/tests?\s*BLOCKED|BLOCKED\s*tests?|BLOCKED\s*\(/i.test(content)) {
          // "tests BLOCKED" or "BLOCKED tests" or "BLOCKED (reason)"
          issues.hasBlocked = true;
        }
      }
    }

    // Check for forbidden QA excuses
    const forbiddenExcuses = [
      /CI\s*(e2e|tests?)\s*provide\s*coverage/i,
      /deferred\s*to\s*(automated|CI)\s*tests/i,
      /API\s*tests?\s*(are|is)\s*sufficient/i,
      /browser\s*testing\s*not\s*needed/i,
      /screenshots?\s*not\s*required/i,
      /didn'?t\s*use\s*Playwright/i,
      /Playwright\s*not\s*used/i,
      /skipped\s*browser\s*test/i
    ];

    for (const pattern of forbiddenExcuses) {
      if (pattern.test(content)) {
        issues.hasForbiddenExcuse = true;
        break;
      }
    }

    // Check if it claims to be APPROVED despite issues
    if (/APPROVED/i.test(content) || /Status:\s*PASS/i.test(content)) {
      issues.claimsApproved = true;
    }

    return issues;
  } catch {
    return null;
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const cwd = process.cwd();

  // Get current task ID
  const currentTaskId = getCurrentTaskId(cwd);

  if (!currentTaskId) {
    // Not working on a specific task - approve
    process.exit(0);
  }

  // Check directories for the current task's report
  const mainWorktree = config.repoDir();
  const dirsToCheck = [cwd];
  if (cwd !== mainWorktree) {
    dirsToCheck.push(mainWorktree);
  }

  const warnings = [];

  for (const dir of dirsToCheck) {
    // Only check the CURRENT task's code-review.md
    const filePath = findCodeReviewForTask(dir, currentTaskId);

    if (!filePath) continue;

    // Only check recently modified files
    if (!isRecentlyModified(filePath)) {
      continue;
    }

    const issues = checkCodeReview(filePath);
    if (!issues) continue;

    // Check if reply file exists
    const taskFolder = path.dirname(filePath);
    const replyPath = path.join(taskFolder, 'code-review-reply.check.md');
    const hasReplyFile = fs.existsSync(replyPath);

    // Check for violations - CRITICAL issues MUST have reply file
    if (issues.hasCritical && !hasReplyFile) {
      warnings.push(
        `CODE REVIEW: CRITICAL ISSUES REQUIRE RESPONSE\n\n` +
        `Task: ${currentTaskId}\n` +
        `File: ${currentTaskId}/code-review.check.md\n\n` +
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

    // IMPORTANT issues also need reply file
    if (issues.hasImportant && !hasReplyFile) {
      warnings.push(
        `CODE REVIEW: IMPORTANT ISSUES REQUIRE RESPONSE\n\n` +
        `Task: ${currentTaskId}\n` +
        `File: ${currentTaskId}/code-review.check.md\n\n` +
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

    if (issues.hasBlocked) {
      warnings.push(
        `BLOCKED TESTS DETECTED\n\n` +
        `Task: ${currentTaskId}\n` +
        `File: ${currentTaskId}/code-review.check.md\n\n` +
        `Report contains BLOCKED tests\n` +
        `BLOCKED = FAIL, not PASS\n\n` +
        `Fix the blocking issue (likely Playwright MCP) and re-run /check.`
      );
    }

    if (issues.hasForbiddenExcuse) {
      warnings.push(
        `QA REPORT CONTAINS FORBIDDEN EXCUSE\n\n` +
        `Task: ${currentTaskId}\n` +
        `File: ${currentTaskId}/code-review.check.md\n\n` +
        `Report uses a forbidden excuse to skip Playwright testing\n` +
        `"CI tests provide coverage" is NOT acceptable\n` +
        `"Deferred to automated tests" is NOT acceptable\n\n` +
        `QA MUST use Playwright browser tools - no exceptions.\n` +
        `Re-run /check with proper Playwright browser testing.`
      );
    }
  }

  // Check QA reports for Playwright verification
  for (const dir of dirsToCheck) {
    const qaReports = findQaReportsForTask(dir, currentTaskId);

    for (const qaFile of qaReports) {
      if (!isRecentlyModified(qaFile)) continue;

      const qaIssues = checkQaReport(qaFile);
      if (!qaIssues) continue;

      const fileName = path.basename(qaFile);

      // Check for forbidden excuses in QA report
      if (qaIssues.hasForbiddenExcuse) {
        warnings.push(
          `QA REPORT CONTAINS FORBIDDEN EXCUSE\n\n` +
          `Task: ${currentTaskId}\n` +
          `File: ${currentTaskId}/${fileName}\n\n` +
          `Report uses a forbidden excuse to skip Playwright testing\n` +
          `"CI tests provide coverage" is NOT acceptable\n` +
          `"Playwright unavailable" is NOT acceptable without trying\n\n` +
          `QA MUST use Playwright browser tools - no exceptions.\n` +
          `Re-run /check with proper Playwright browser testing.`
        );
      }

      // Check for missing Playwright verification when claiming PASS
      if (qaIssues.claimsPass && !qaIssues.hasPlaywrightVerification) {
        warnings.push(
          `QA REPORT MISSING PLAYWRIGHT VERIFICATION\n\n` +
          `Task: ${currentTaskId}\n` +
          `File: ${currentTaskId}/${fileName}\n\n` +
          `Report claims PASS but has no Playwright verification\n` +
          `Missing "## Playwright Verification" section\n\n` +
          `QA reports MUST include Playwright verification showing:\n` +
          `- mcp__playwright__browser_navigate call\n` +
          `- Result: SUCCESS with page title\n\n` +
          `Re-run /check with proper Playwright browser testing.`
        );
      }

      // Check for missing CONNECTIVITY verification section (NEW - MANDATORY)
      if (!qaIssues.hasConnectivityVerification && !qaIssues.hasGoogleTest) {
        warnings.push(
          `QA REPORT MISSING CONNECTIVITY VERIFICATION\n\n` +
          `Task: ${currentTaskId}\n` +
          `File: ${currentTaskId}/${fileName}\n\n` +
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

      // Check for missing health check specifically
      if (qaIssues.hasGoogleTest && !qaIssues.hasHealthCheck) {
        warnings.push(
          `QA REPORT MISSING APP HEALTH CHECK\n\n` +
          `Task: ${currentTaskId}\n` +
          `File: ${currentTaskId}/${fileName}\n\n` +
          `External connectivity (google.com) verified\n` +
          `But App Health Check is missing\n\n` +
          `QA reports MUST include App Health Check showing:\n` +
          `- Navigate to app URL/health or app URL\n` +
          `- Screenshot of the health check result\n\n` +
          `Re-run /check with app health verification.`
        );
      }
    }
  }

  if (warnings.length > 0) {
    process.stderr.write(warnings.join('\n\n---\n\n') + '\n');
    process.exit(2);
  } else {
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Hook error:', err.message);
  process.exit(0);
});
