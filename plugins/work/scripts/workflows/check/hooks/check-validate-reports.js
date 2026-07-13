#!/usr/bin/env node
/**
 * /check Report Validation Script
 *
 * Validates that all required reports exist and have proper content:
 * - QA reports have connectivity verification section
 * - Code review doesn't have unaddressed CRITICAL/IMPORTANT issues
 * - All expected report files exist
 *
 * Per-report validators live in ../lib/report-validators.js.
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

const path = require('path');
const AppAccessStatus = require(path.join(__dirname, '..', 'lib', 'app-access-status'));
const {
  fileExists,
  parsePlaywrightSkipSignal,
  validateQAReport,
  validateCodeReview,
  validateTestsReport,
  validateCompletionReport,
} = require(path.join(__dirname, '..', 'lib', 'report-validators'));

/** Record one app's QA validation outcome into results/flags. */
function recordQaValidation(results, flags, app, validation) {
  results.reports.qa[app] = validation;

  // Check for infrastructure failure FIRST
  if (validation.infrastructureFailure) {
    flags.hasInfrastructureFailure = true;
    results.overall.issues.push(`Infrastructure failure detected in qa-${app}.check.md`);
    return;
  }
  if (validation.accessFailed) {
    // ACCESS_FAILED is an infrastructure issue, not a test failure
    flags.hasAccessFailure = true;
    flags.accessFailedApps.push(app);
    results.overall.issues.push(
      `${AppAccessStatus.ACCESS_FAILED}: ${app} unreachable (infrastructure issue, not a test failure)`
    );
    return;
  }
  if (!validation.exists) {
    flags.anyQAFailed = true;
    results.overall.issues.push(`QA report missing for ${app}`);
    return;
  }
  if (!validation.valid || validation.failed) {
    flags.anyQAFailed = true;
    flags.testFailedApps.push(app);
    if (validation.issues.length > 0) {
      results.overall.issues.push(`QA report for ${app}: ${validation.issues.join(', ')}`);
    }
    if (validation.failed) {
      results.overall.issues.push(`${AppAccessStatus.TEST_FAILED}: QA tests failed for ${app}`);
    }
  }
}

/** Validate QA reports for each impacted app; returns aggregate flags. */
function validateQaReports(results, reportFolder, impactedApps, isPlaywrightSkipped) {
  results.reports.qa = {};
  const flags = {
    anyQAFailed: false,
    hasInfrastructureFailure: false,
    hasAccessFailure: false,
    accessFailedApps: [],
    testFailedApps: [],
  };
  for (const app of impactedApps) {
    const qaPath = path.join(reportFolder, `qa-${app}.check.md`);
    const validation = validateQAReport(qaPath, app, isPlaywrightSkipped(app));
    recordQaValidation(results, flags, app, validation);
  }
  return flags;
}

/** Validate code review + tests + completion reports into results.overall. */
function applyReportValidations(results, reportFolder) {
  // Validate code review
  results.reports.codeReview = validateCodeReview(reportFolder);
  if (!results.reports.codeReview.exists) {
    results.overall.issues.push('Code review report missing');
  } else if (results.reports.codeReview.hasCritical) {
    results.overall.issues.push('Code review has CRITICAL issues that must be fixed');
    results.overall.valid = false;
  } else if (results.reports.codeReview.hasImportant) {
    results.overall.issues.push('Code review has IMPORTANT issues (should fix or document)');
  }

  // Validate tests report
  results.reports.tests = validateTestsReport(reportFolder);
  if (!results.reports.tests.exists) {
    results.overall.issues.push('Tests report missing');
    results.overall.valid = false;
  } else if (!results.reports.tests.passed) {
    results.overall.issues.push('Tests did not pass');
    results.overall.valid = false;
  }

  // Validate completion report
  results.reports.completion = validateCompletionReport(reportFolder);
  if (!results.reports.completion.exists) {
    results.overall.issues.push('Completion report missing');
  } else if (results.reports.completion.incomplete) {
    results.overall.issues.push('Some requirements are incomplete');
  }
}

/** Determine overall status + verify required files exist. */
function finalizeResults(results, reportFolder, anyQAFailed) {
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
    if (!fileExists(path.join(reportFolder, file))) {
      results.overall.issues.push(`Missing required file: ${file}`);
    }
  }
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

  const flags = validateQaReports(results, REPORT_FOLDER, IMPACTED_APPS, isPlaywrightSkipped);

  // Handle infrastructure failure immediately
  if (flags.hasInfrastructureFailure) {
    results.overall.infrastructureFailure = true;
    results.overall.status = 'INFRASTRUCTURE_FAILURE';
    results.overall.valid = false;
    console.log(JSON.stringify(results, null, 2));
    process.exit(2); // Special exit code for infra failure
  }

  // ACCESS_FAILED is tracked separately — it's an infrastructure issue, not a test failure.
  // The overall result includes accessFailure info but doesn't set valid=false,
  // allowing the workflow to proceed while reporting the access issue.
  if (flags.hasAccessFailure) {
    results.overall.accessFailure = true;
    results.overall.accessFailedApps = flags.accessFailedApps;
  }
  if (flags.testFailedApps.length > 0) {
    results.overall.testFailedApps = flags.testFailedApps;
  }

  applyReportValidations(results, REPORT_FOLDER);
  finalizeResults(results, REPORT_FOLDER, flags.anyQAFailed);

  console.log(JSON.stringify(results, null, 2));

  // Exit with appropriate code
  process.exit(results.overall.valid ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { validateCodeReview, validateQAReport, parsePlaywrightSkipSignal };
