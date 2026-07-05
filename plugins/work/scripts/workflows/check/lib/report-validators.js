'use strict';

/**
 * check/lib/report-validators.js — per-report validation helpers for the
 * /check report validation hook (extracted from hooks/check-validate-reports.js,
 * which re-exports the public pieces for backward compatibility).
 */

const fs = require('fs');
const path = require('path');
const AppAccessStatus = require(path.join(__dirname, 'app-access-status'));
const { detectSeverityMarkers } = require(path.join(__dirname, 'severity-detection'));

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
 * Infrastructure/access short-circuits, checked FIRST.
 * Returns a full validation result, or null when neither applies.
 */
function detectQaInfrastructureResult(content, appName) {
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
  // ACCESS_FAILED (app unreachable — infrastructure issue, not a test failure)
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
  return null;
}

/** Content-marker issues for a QA report (Playwright section, hash, screenshots, status). */
function collectQaContentIssues(content, effectivePlaywrightSkipped, hasScreenshots) {
  const issues = [];

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

  return issues;
}

/**
 * Check if marked as failed using the FIRST Status: line + body markers in
 * current run. Reports may contain "Previous Run" sections with stale
 * statuses — limit body scan to content before the first "# Previous Run"
 * delimiter.
 */
function qaReportFailed(content) {
  const statusLineMatch = content.match(/^Status:\s*(\S+)/m);
  const firstStatus = statusLineMatch ? statusLineMatch[1] : '';
  const prevRunIdx = content.indexOf('# Previous Run');
  const currentRunContent = prevRunIdx > -1 ? content.slice(0, prevRunIdx) : content;
  const bodyHasFailMarker =
    currentRunContent.includes('❌ FAIL') || currentRunContent.includes('❌ NEEDS_WORK');
  return statusLineMatch
    ? firstStatus === 'FAIL' || firstStatus === 'NEEDS_WORK' || bodyHasFailMarker
    : bodyHasFailMarker;
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

  const infrastructureResult = detectQaInfrastructureResult(content, appName);
  if (infrastructureResult) return infrastructureResult;

  // Playwright section + screenshots are mandatory UNLESS the check plan
  // skipped Playwright verification (no web apps) or the report explicitly
  // declares "APPROVED (SKIPPED)" (GH-280).
  const effectivePlaywrightSkipped = playwrightSkipped === true || reportDeclaresSkip(content);
  const hasScreenshots = content.includes('![') || content.includes('./screenshots/');
  const issues = collectQaContentIssues(content, effectivePlaywrightSkipped, hasScreenshots);
  const failed = qaReportFailed(content);

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

module.exports = {
  fileExists,
  readFile,
  parsePlaywrightSkipSignal,
  validateQAReport,
  validateCodeReview,
  validateTestsReport,
  validateCompletionReport,
};
