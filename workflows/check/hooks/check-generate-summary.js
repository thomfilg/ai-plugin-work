#!/usr/bin/env node
/**
 * /check Summary Generator
 *
 * Generates the final README.md summary report after all agents complete.
 *
 * Usage: node check-generate-summary.js <REPORT_FOLDER> <CHANGES_HASH> [TICKET_ID] [IMPACTED_APPS_JSON]
 *
 * Output: Writes README.md to report folder
 */

const fs = require('fs');
const path = require('path');
const AppAccessStatus = require(path.join(__dirname, '..', 'lib', 'app-access-status'));

// Get args (only when run as CLI)
let REPORT_FOLDER, CHANGES_HASH, TICKET_ID, IMPACTED_APPS;
if (require.main === module) {
  REPORT_FOLDER = process.argv[2];
  CHANGES_HASH = process.argv[3];
  TICKET_ID = process.argv[4] || '';
  try {
    IMPACTED_APPS = JSON.parse(process.argv[5] || '[]');
    if (!Array.isArray(IMPACTED_APPS)) {
      console.error('Error: IMPACTED_APPS_JSON must be a JSON array (e.g. \'["app1","app2"]\')');
      process.exit(1);
    }
  } catch {
    console.error('Error: IMPACTED_APPS_JSON must be valid JSON (e.g. \'["app1","app2"]\')');
    process.exit(1);
  }

  if (!REPORT_FOLDER || !CHANGES_HASH) {
    console.error(
      'Usage: node check-generate-summary.js <REPORT_FOLDER> <CHANGES_HASH> [TICKET_ID] [IMPACTED_APPS_JSON]'
    );
    process.exit(1);
  }
}

/**
 * Read file content
 */
function readFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Check report status from content
 */
function getReportStatus(content, type) {
  if (!content) return { status: 'MISSING', icon: '❓' };

  // Check for infrastructure/access failure FIRST (for QA reports)
  if (type === 'qa') {
    if (
      content.includes('INFRASTRUCTURE_FAILURE') ||
      content.includes('PLAYWRIGHT_UNAVAILABLE') ||
      content.includes('PLAYWRIGHT UNAVAILABLE')
    ) {
      return { status: 'INFRASTRUCTURE_FAILURE', icon: '🛑' };
    }
    if (content.includes(AppAccessStatus.ACCESS_FAILED)) {
      return { status: AppAccessStatus.ACCESS_FAILED, icon: '🔒' };
    }
  }

  const statusChecks = {
    tests: {
      pass: ['✅ PASS', 'APPROVED', 'All.*pass'],
      fail: ['❌ FAIL', 'NEEDS_WORK', 'fail [1-9]\\d*'],
    },
    codeReview: {
      pass: ['APPROVED', 'No critical', 'No issues'],
      fail: ['CRITICAL', 'NEEDS_WORK'],
    },
    qa: {
      pass: ['✅ PASS', 'All tests passed', 'SUCCESS', 'Status:\\s*APPROVED'],
      fail: [
        '❌ FAIL',
        'FAILED:\\s*[1-9]',
        'failures:\\s*[1-9]',
        'Status:\\s*FAIL',
        'Status:\\s*NEEDS_WORK',
      ],
    },
    completion: {
      pass: ['COMPLETE', 'DELIVERED'],
      fail: ['INCOMPLETE', 'PENDING'],
    },
  };

  const checks = statusChecks[type];
  if (!checks) return { status: 'UNKNOWN', icon: '❓' };

  // Check for failures first — fail markers take precedence to avoid false negatives
  // (pass-first ordering would silence explicit NEEDS_WORK when a pass pattern also matches)
  for (const pattern of checks.fail) {
    if (new RegExp(pattern, 'i').test(content)) {
      return { status: 'NEEDS_WORK', icon: '❌' };
    }
  }

  // Check for pass
  for (const pattern of checks.pass) {
    if (new RegExp(pattern, 'i').test(content)) {
      return { status: 'APPROVED', icon: '✅' };
    }
  }

  return { status: 'UNKNOWN', icon: '❓' };
}

/**
 * Generate summary report
 */
function generateSummary() {
  const timestamp = new Date().toISOString();
  const branchName = require('child_process')
    .execSync('git branch --show-current', { encoding: 'utf8' })
    .trim();

  // Read all reports
  const testsContent = readFile(path.join(REPORT_FOLDER, 'tests.check.md'));
  const codeReviewContent = readFile(path.join(REPORT_FOLDER, 'code-review.check.md'));
  const completionContent = readFile(path.join(REPORT_FOLDER, 'completion.check.md'));

  // Get statuses
  const testsStatus = getReportStatus(testsContent, 'tests');
  const codeReviewStatus = getReportStatus(codeReviewContent, 'codeReview');
  const completionStatus = getReportStatus(completionContent, 'completion');

  // Get QA statuses for each app
  const qaStatuses = {};
  let overallQAStatus = { status: 'APPROVED', icon: '✅' };
  let hasInfraFailure = false;
  let hasAccessFailure = false;
  const accessFailedApps = [];
  const testFailedApps = [];

  for (const app of IMPACTED_APPS) {
    const qaContent = readFile(path.join(REPORT_FOLDER, `qa-${app}.check.md`));
    qaStatuses[app] = getReportStatus(qaContent, 'qa');

    if (qaStatuses[app].status === 'INFRASTRUCTURE_FAILURE') {
      hasInfraFailure = true;
      overallQAStatus = { status: 'INFRASTRUCTURE_FAILURE', icon: '🛑' };
    } else if (qaStatuses[app].status === AppAccessStatus.ACCESS_FAILED) {
      hasAccessFailure = true;
      accessFailedApps.push(app);
      if (!hasInfraFailure) {
        overallQAStatus = { status: AppAccessStatus.ACCESS_FAILED, icon: '🔒' };
      }
    } else if (qaStatuses[app].status === 'NEEDS_WORK' && !hasInfraFailure) {
      testFailedApps.push(app);
      overallQAStatus = { status: 'NEEDS_WORK', icon: '❌' };
    } else if (qaStatuses[app].status === 'MISSING' && overallQAStatus.status === 'APPROVED') {
      overallQAStatus = { status: 'MISSING', icon: '❓' };
    }
  }

  // Check if code-review-reply.check.md exists
  const hasReplyFile = fs.existsSync(path.join(REPORT_FOLDER, 'code-review-reply.check.md'));

  // Determine overall status
  let overallStatus = 'APPROVED';
  const actionItems = [];

  // Infrastructure failure takes precedence
  if (hasInfraFailure) {
    overallStatus = 'INFRASTRUCTURE_FAILURE';
    actionItems.unshift(
      '⚠️ FIX INFRASTRUCTURE: Playwright MCP unavailable - fix before re-running /check'
    );
  }
  if (hasAccessFailure) {
    if (overallStatus !== 'INFRASTRUCTURE_FAILURE') {
      overallStatus = AppAccessStatus.ACCESS_FAILED;
    }
    actionItems.push(
      `🔒 ACCESS_FAILED: App(s) unreachable (${accessFailedApps.join(', ')}) - infrastructure issue, not a test failure`
    );
  }
  if (testsStatus.status === 'NEEDS_WORK') {
    overallStatus = overallStatus === 'INFRASTRUCTURE_FAILURE' ? overallStatus : 'NEEDS_WORK';
    actionItems.push('Fix failing tests (see tests.check.md)');
  }
  if (codeReviewStatus.status === 'NEEDS_WORK') {
    overallStatus = overallStatus === 'INFRASTRUCTURE_FAILURE' ? overallStatus : 'NEEDS_WORK';
    actionItems.push('Address code review issues (see code-review.check.md)');
  }
  if (overallQAStatus.status === 'NEEDS_WORK') {
    overallStatus = overallStatus === 'INFRASTRUCTURE_FAILURE' ? overallStatus : 'NEEDS_WORK';
    actionItems.push(
      `Fix QA test failures (${testFailedApps.length > 0 ? testFailedApps.join(', ') : 'see qa-*.check.md'})`
    );
  }
  if (completionStatus.status === 'NEEDS_WORK') {
    overallStatus = overallStatus === 'INFRASTRUCTURE_FAILURE' ? overallStatus : 'NEEDS_WORK';
    actionItems.push('Complete pending requirements (see completion.check.md)');
  }

  // Build QA rows
  const qaRows = IMPACTED_APPS.map((app) => {
    const status = qaStatuses[app] || { status: 'MISSING', icon: '❓' };
    return `| QA Tester (${app}) | ${status.icon} ${status.status} |`;
  }).join('\n');

  // Build QA links
  const qaLinks = IMPACTED_APPS.map((app) => `- [qa-${app}.check.md](./qa-${app}.check.md)`).join(
    '\n'
  );

  // Generate markdown
  const markdown = `# Quality Check Report
${TICKET_ID ? `Ticket: ${TICKET_ID}` : `Branch: ${branchName}`}
Generated: ${timestamp}
**Changes Hash:** ${CHANGES_HASH}

## Summary
| Check | Status |
|-------|--------|
| Quality Checker (lint/typecheck/tests) | ${testsStatus.icon} ${testsStatus.status} |
| Code Checker | ${codeReviewStatus.icon} ${codeReviewStatus.status} |
${qaRows}
| Completion Checker | ${completionStatus.icon} ${completionStatus.status} |

## Quality Check Results (lint, typecheck, tests)
See: [tests.check.md](./tests.check.md)

## Code Checker Report
See: [code-review.check.md](./code-review.check.md)

## QA Test Reports
${accessFailedApps.length > 0 ? `### Access Failed (infrastructure issue)\n${accessFailedApps.map((app) => `- 🔒 **${app}** — ${AppAccessStatus.ACCESS_FAILED} (app unreachable, not a test failure)`).join('\n')}\n\n` : ''}${testFailedApps.length > 0 ? `### Test Failed\n${testFailedApps.map((app) => `- ❌ **${app}** — ${AppAccessStatus.TEST_FAILED}`).join('\n')}\n\n` : ''}${qaLinks}

## Completion Check
See: [completion.check.md](./completion.check.md)

## Generated Report Files
- [tests.check.md](./tests.check.md)
- [code-review.check.md](./code-review.check.md)
${hasReplyFile ? '- [code-review-reply.check.md](./code-review-reply.check.md)\n' : ''}${qaLinks}
- [completion.check.md](./completion.check.md)
- [screenshots/](./screenshots/) (QA visual evidence)

## Overall Status
**${overallStatus}**

${
  actionItems.length > 0
    ? `## Action Items
${actionItems.map((item) => `- ${item}`).join('\n')}`
    : '✅ All checks passed! Ready for PR.'
}
`;

  // Write README.md
  const readmePath = path.join(REPORT_FOLDER, 'README.md');
  fs.writeFileSync(readmePath, markdown);

  console.log(
    JSON.stringify(
      {
        readmePath,
        overallStatus,
        infrastructureFailure: hasInfraFailure,
        accessFailure: hasAccessFailure,
        accessFailedApps,
        testFailedApps,
        testsStatus: testsStatus.status,
        codeReviewStatus: codeReviewStatus.status,
        qaStatus: overallQAStatus.status,
        completionStatus: completionStatus.status,
        hasReplyFile,
        actionItems,
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  generateSummary();
}

module.exports = { getReportStatus };
