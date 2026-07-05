#!/usr/bin/env node
/**
 * /check Report Validation Script
 *
 * Validates that all required reports exist and have proper content:
 * - QA reports have connectivity verification section
 * - Code review doesn't have unaddressed CRITICAL/IMPORTANT issues
 * - All expected report files exist
 *
 * Usage: node check-validate-reports.js <REPORT_FOLDER> <IMPACTED_APPS_JSON> [PLAYWRIGHT_SKIPPED_JSON]
 *
 * PLAYWRIGHT_SKIPPED_JSON (optional, GH-280): `true`/`false` for a global
 * signal, or a per-app map like {"my-app":true}. When the check plan skipped
 * 3_verify_playwright (no web apps configured), pass `true` so QA reports are
 * accepted without a "## Playwright Verification" section or screenshots.
 * Malformed values fail CLOSED (Playwright evidence remains required).
 *
 * Output: JSON object with validation results
 */

const fs = require('fs');
const path = require('path');
const AppAccessStatus = require(path.join(__dirname, '..', 'lib', 'app-access-status'));
const { detectSeverityMarkers } = require(path.join(__dirname, '..', 'lib', 'severity-detection'));

/**
 * Check if a file exists AND is non-empty. A 0-byte report is a clobber-race
 * victim (GH-611) and must be treated as missing, not present.
 */
function fileExists(filePath) {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

/**
 * Read file content
 */
function readFile(filePath) {
  if (!fileExists(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Parse the PLAYWRIGHT_SKIPPED_JSON CLI argument (GH-280).
 * Accepts a boolean (`true`/`false`) or a per-app map ({"app": true}).
 * Malformed input fails CLOSED — Playwright evidence stays required.
 * @returns {(appName: string) => boolean}
 */
function parsePlaywrightSkipSignal(raw) {
  if (raw === undefined || raw === null || raw === '') return () => false;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return () => false; // fail closed
  }
  if (typeof parsed === 'boolean') return () => parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return (appName) => parsed[appName] === true;
  }
  return () => false; // fail closed on any other shape
}

/**
 * Detect an explicit in-report skip status: "APPROVED (SKIPPED)".
 * Written when QA was intentionally skipped (e.g. no web apps configured),
 * so Playwright evidence must not be demanded (GH-280).
 */
function reportDeclaresSkip(content) {
  return /^Status:\s*APPROVED\s*\(SKIPPED\)/im.test(content);
}

/**
 * Validate QA report has required content.
 *
 * When `playwrightSkipped` is true (the check plan skipped 3_verify_playwright
 * — no web apps configured), or the report itself declares
 * "Status: APPROVED (SKIPPED)", the "## Playwright Verification" section and
 * screenshot requirements are relaxed. All other markers stay mandatory.
 */
function validateQAReport(filePath, appName, playwrightSkipped = false) {
  const content = readFile(filePath);

  if (!content) {
    return {
      exists: false,
      valid: false,
      error: `QA report not found: ${filePath}`,
    };
  }

  const issues = [];

  // Check for infrastructure failure FIRST
  const hasInfraFailure =
    content.includes('INFRASTRUCTURE_FAILURE') ||
    content.includes('PLAYWRIGHT_UNAVAILABLE') ||
    content.includes('PLAYWRIGHT UNAVAILABLE');
  if (hasInfraFailure) {
    return {
      exists: true,
      valid: false,
      infrastructureFailure: true,
      accessFailed: false,
      issues: ['Infrastructure failure - Playwright unavailable'],
      failed: true,
    };
  }

  // Check for ACCESS_FAILED (app unreachable — infrastructure issue, not a test failure)
  if (content.includes(AppAccessStatus.ACCESS_FAILED)) {
    return {
      exists: true,
      valid: false,
      infrastructureFailure: false,
      accessFailed: true,
      issues: [
        `App access failed for ${appName} — app unreachable (infrastructure issue, not a test failure)`,
      ],
      failed: false, // Not a test failure
    };
  }

  // Playwright section + screenshots are mandatory UNLESS the check plan
  // skipped Playwright verification (no web apps) or the report explicitly
  // declares "APPROVED (SKIPPED)" (GH-280).
  const effectivePlaywrightSkipped = playwrightSkipped === true || reportDeclaresSkip(content);

  // Check for Playwright Verification section (MANDATORY when not skipped)
  const hasPlaywrightVerification = content.includes('## Playwright Verification');
  if (!hasPlaywrightVerification && !effectivePlaywrightSkipped) {
    issues.push('Missing "## Playwright Verification" section');
  }

  // Check for Changes Hash
  if (!content.includes('**Changes Hash:**')) {
    issues.push('Missing "**Changes Hash:**" at top of report');
  }

  // Check for screenshots (required for QA when Playwright is not skipped)
  const hasScreenshots = content.includes('![') || content.includes('./screenshots/');
  if (!hasScreenshots && !effectivePlaywrightSkipped) {
    issues.push('No screenshots found - QA reports must include visual evidence');
  }

  // Check for pass/fail status (canonical: APPROVED/NEEDS_WORK, legacy: PASS/FAIL)
  const hasStatus =
    content.includes('PASS') ||
    content.includes('FAIL') ||
    content.includes('APPROVED') ||
    content.includes('NEEDS_WORK');
  if (!hasStatus) {
    issues.push('Missing PASS/FAIL/APPROVED/NEEDS_WORK status');
  }

  // Check if marked as failed using the FIRST Status: line + body markers in current run.
  // Reports may contain "Previous Run" sections with stale statuses — limit body scan
  // to content before the first "# Previous Run" delimiter.
  const statusLineMatch = content.match(/^Status:\s*(\S+)/m);
  const firstStatus = statusLineMatch ? statusLineMatch[1] : '';
  const prevRunIdx = content.indexOf('# Previous Run');
  const currentRunContent = prevRunIdx > -1 ? content.slice(0, prevRunIdx) : content;
  const bodyHasFailMarker =
    currentRunContent.includes('❌ FAIL') || currentRunContent.includes('❌ NEEDS_WORK');
  const failed = statusLineMatch
    ? firstStatus === 'FAIL' || firstStatus === 'NEEDS_WORK' || bodyHasFailMarker
    : bodyHasFailMarker;

  return {
    exists: true,
    valid: issues.length === 0 && !failed,
    issues,
    failed,
    hasScreenshots,
    playwrightSkipped: effectivePlaywrightSkipped,
    infrastructureFailure: false,
    accessFailed: false,
  };
}

/**
 * Validate code review report
 */
function validateCodeReview(reportFolder) {
  const filePath = path.join(reportFolder, 'code-review.check.md');
  const content = readFile(filePath);

  if (!content) {
    return {
      exists: false,
      valid: false,
      error: 'Code review report not found',
    };
  }

  const issues = [];

  // Check for Changes Hash
  if (!content.includes('**Changes Hash:**')) {
    issues.push('Missing "**Changes Hash:**" at top of report');
  }

  // Detect severity markers using line-based analysis with negation filtering
  const markers = detectSeverityMarkers(content);
  const hasCritical = markers.critical.length > 0;
  const hasImportant = markers.important.length > 0;

  // Check if there's a reply file addressing the issues
  const replyPath = path.join(reportFolder, 'code-review-reply.check.md');
  const hasReply = fileExists(replyPath);

  return {
    exists: true,
    valid: !hasCritical, // Only critical blocks approval
    hasCritical,
    hasImportant,
    hasReply,
    issues,
    requiresAction: hasCritical || hasImportant,
  };
}

/**
 * Validate tests report
 */
function validateTestsReport(reportFolder) {
  const filePath = path.join(reportFolder, 'tests.check.md');
  const content = readFile(filePath);

  if (!content) {
    return {
      exists: false,
      valid: false,
      error: 'Tests report not found',
    };
  }

  const issues = [];

  // Check for Changes Hash
  if (!content.includes('**Changes Hash:**')) {
    issues.push('Missing "**Changes Hash:**" at top of report');
  }

  // Check for pass/fail indicators
  const hasPass = content.includes('✅ PASS') || content.includes('APPROVED');
  const hasFail = content.includes('❌ FAIL') || content.includes('NEEDS_WORK');

  // Check for SKIPPED/BLOCKED tests (acceptable but should note)
  const hasSkipped = content.includes('⚠️ SKIPPED') || content.includes('BLOCKED');

  return {
    exists: true,
    valid: hasPass && !hasFail,
    passed: hasPass && !hasFail,
    hasSkipped,
    issues,
  };
}

/**
 * Validate completion report
 */
function validateCompletionReport(reportFolder) {
  const filePath = path.join(reportFolder, 'completion.check.md');
  const content = readFile(filePath);

  if (!content) {
    return {
      exists: false,
      valid: false,
      error: 'Completion report not found',
    };
  }

  const issues = [];

  // Check for Changes Hash
  if (!content.includes('**Changes Hash:**')) {
    issues.push('Missing "**Changes Hash:**" at top of report');
  }

  // Check for COMPLETE/INCOMPLETE
  const isComplete = content.includes('COMPLETE') && !content.includes('INCOMPLETE');
  const isIncomplete = content.includes('INCOMPLETE');

  return {
    exists: true,
    valid: isComplete,
    complete: isComplete,
    incomplete: isIncomplete,
    issues,
  };
}

/**
 * Main validation
 */
function main() {
  // Get args
  const REPORT_FOLDER = process.argv[2];
  const IMPACTED_APPS = JSON.parse(process.argv[3] || '[]');
  // Optional 3rd arg: playwright-skip signal from the check plan (GH-280)
  const isPlaywrightSkipped = parsePlaywrightSkipSignal(process.argv[4]);

  if (!REPORT_FOLDER) {
    console.error('Usage: node check-validate-reports.js <REPORT_FOLDER> <IMPACTED_APPS_JSON>');
    process.exit(1);
  }

  const results = {
    reportFolder: REPORT_FOLDER,
    impactedApps: IMPACTED_APPS,
    reports: {},
    overall: {
      valid: true,
      issues: [],
      status: 'APPROVED',
      infrastructureFailure: false,
    },
  };

  // Validate QA reports for each impacted app
  results.reports.qa = {};
  let anyQAFailed = false;
  let hasInfrastructureFailure = false;
  let hasAccessFailure = false;
  const accessFailedApps = [];
  const testFailedApps = [];

  for (const app of IMPACTED_APPS) {
    const qaPath = path.join(REPORT_FOLDER, `qa-${app}.check.md`);
    const validation = validateQAReport(qaPath, app, isPlaywrightSkipped(app));
    results.reports.qa[app] = validation;

    // Check for infrastructure failure FIRST
    if (validation.infrastructureFailure) {
      hasInfrastructureFailure = true;
      results.overall.issues.push(`Infrastructure failure detected in qa-${app}.check.md`);
    } else if (validation.accessFailed) {
      // ACCESS_FAILED is an infrastructure issue, not a test failure
      hasAccessFailure = true;
      accessFailedApps.push(app);
      results.overall.issues.push(
        `${AppAccessStatus.ACCESS_FAILED}: ${app} unreachable (infrastructure issue, not a test failure)`
      );
    } else if (!validation.exists) {
      anyQAFailed = true;
      results.overall.issues.push(`QA report missing for ${app}`);
    } else if (!validation.valid || validation.failed) {
      anyQAFailed = true;
      testFailedApps.push(app);
      if (validation.issues.length > 0) {
        results.overall.issues.push(`QA report for ${app}: ${validation.issues.join(', ')}`);
      }
      if (validation.failed) {
        results.overall.issues.push(`${AppAccessStatus.TEST_FAILED}: QA tests failed for ${app}`);
      }
    }
  }

  // Handle infrastructure failure immediately
  if (hasInfrastructureFailure) {
    results.overall.infrastructureFailure = true;
    results.overall.status = 'INFRASTRUCTURE_FAILURE';
    results.overall.valid = false;
    console.log(JSON.stringify(results, null, 2));
    process.exit(2); // Special exit code for infra failure
  }

  // ACCESS_FAILED is tracked separately — it's an infrastructure issue, not a test failure.
  // The overall result includes accessFailure info but doesn't set valid=false,
  // allowing the workflow to proceed while reporting the access issue.
  if (hasAccessFailure) {
    results.overall.accessFailure = true;
    results.overall.accessFailedApps = accessFailedApps;
  }
  if (testFailedApps.length > 0) {
    results.overall.testFailedApps = testFailedApps;
  }

  // Validate code review
  results.reports.codeReview = validateCodeReview(REPORT_FOLDER);
  if (!results.reports.codeReview.exists) {
    results.overall.issues.push('Code review report missing');
  } else if (results.reports.codeReview.hasCritical) {
    results.overall.issues.push('Code review has CRITICAL issues that must be fixed');
    results.overall.valid = false;
  } else if (results.reports.codeReview.hasImportant) {
    results.overall.issues.push('Code review has IMPORTANT issues (should fix or document)');
  }

  // Validate tests report
  results.reports.tests = validateTestsReport(REPORT_FOLDER);
  if (!results.reports.tests.exists) {
    results.overall.issues.push('Tests report missing');
    results.overall.valid = false;
  } else if (!results.reports.tests.passed) {
    results.overall.issues.push('Tests did not pass');
    results.overall.valid = false;
  }

  // Validate completion report
  results.reports.completion = validateCompletionReport(REPORT_FOLDER);
  if (!results.reports.completion.exists) {
    results.overall.issues.push('Completion report missing');
  } else if (results.reports.completion.incomplete) {
    results.overall.issues.push('Some requirements are incomplete');
  }

  // Determine overall status
  if (anyQAFailed) {
    results.overall.status = 'NEEDS_WORK';
    results.overall.valid = false;
  } else if (!results.overall.valid) {
    results.overall.status = 'NEEDS_WORK';
  } else if (results.overall.issues.length > 0) {
    results.overall.status = 'APPROVED_WITH_NOTES';
  }

  // Check if all required files exist
  const requiredFiles = [
    'tests.check.md',
    'code-review.check.md',
    'completion.check.md',
    'README.md',
  ];
  for (const file of requiredFiles) {
    if (!fileExists(path.join(REPORT_FOLDER, file))) {
      results.overall.issues.push(`Missing required file: ${file}`);
    }
  }

  console.log(JSON.stringify(results, null, 2));

  // Exit with appropriate code
  process.exit(results.overall.valid ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { validateCodeReview, validateQAReport, parsePlaywrightSkipSignal };
