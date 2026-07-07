'use strict';

/**
 * review-report-checks.js — report discovery + parsing for the
 * work-code-review-status Stop hook.
 *
 * Pure read-side helpers: locate a task's code-review / QA reports and parse
 * them into issue-flag objects. All regexes are verbatim from the legacy hook
 * — the flags they produce drive byte-pinned warning messages.
 */

const fs = require('fs');
const path = require('path');

// Find code-review.check.md for a specific task
function findCodeReviewForTask(config, baseDir, taskId) {
  if (!taskId) return null;

  const tasksDir = path.join(baseDir, 'tasks');
  const taskFolder = path.join(tasksDir, config.safeTicketId(taskId));
  const reviewFile = path.join(taskFolder, 'code-review.check.md');

  if (fs.existsSync(reviewFile)) {
    return reviewFile;
  }

  return null;
}

// Find QA reports for a specific task
function findQaReportsForTask(config, baseDir, taskId) {
  if (!taskId) return [];

  const tasksDir = path.join(baseDir, 'tasks');
  const taskFolder = path.join(tasksDir, config.safeTicketId(taskId));

  if (!fs.existsSync(taskFolder)) return [];

  const files = fs.readdirSync(taskFolder);
  return files
    .filter((f) => f.startsWith('qa') && f.endsWith('.check.md'))
    .map((f) => path.join(taskFolder, f));
}

// Forbidden excuses for skipping Playwright testing, per report type. The QA
// list carries one extra pattern ("Playwright (MCP) tools unavailable").
const QA_FORBIDDEN_EXCUSES = [
  /CI\s*(e2e|tests?)\s*provide\s*coverage/i,
  /deferred\s*to\s*(automated|CI)\s*tests/i,
  /API\s*tests?\s*(are|is)\s*sufficient/i,
  /browser\s*testing\s*not\s*needed/i,
  /screenshots?\s*not\s*required/i,
  /didn'?t\s*use\s*Playwright/i,
  /Playwright\s*not\s*used/i,
  /Playwright\s*(MCP\s*)?tools?\s*unavailable/i,
  /skipped\s*browser\s*test/i,
];

const CR_FORBIDDEN_EXCUSES = [
  /CI\s*(e2e|tests?)\s*provide\s*coverage/i,
  /deferred\s*to\s*(automated|CI)\s*tests/i,
  /API\s*tests?\s*(are|is)\s*sufficient/i,
  /browser\s*testing\s*not\s*needed/i,
  /screenshots?\s*not\s*required/i,
  /didn'?t\s*use\s*Playwright/i,
  /Playwright\s*not\s*used/i,
  /skipped\s*browser\s*test/i,
];

// Signal table for QA reports: a flag is set when ANY of its patterns match.
// Alternatives (e.g. google.com URL with status) are verbatim legacy checks.
const QA_SIGNALS = {
  // NEW Connectivity Verification section (MANDATORY)
  hasConnectivityVerification: [/##\s*Playwright\s*Connectivity\s*Verification/i],
  hasGoogleTest: [
    /###\s*External\s*Connectivity\s*\(google\.com\)/i,
    /google\.com.*Status:\s*(✅|SUCCESS|FAILED|❌)/i,
    /Status:.*google\.com/i,
  ],
  hasHealthCheck: [
    /###\s*App\s*Health\s*Check/i,
    /\/health.*Status:\s*(✅|SUCCESS|FAILED|❌)/i,
    /host\.docker\.internal.*Status:/i,
  ],
  hasScreenshots: [/!\[.*\]\(.*\.png\)/i, /screenshots?\//i],
  claimsPass: [/Status:\s*PASS|✅\s*PASS|All\s*tests?\s*pass/i],
};

// Check QA report for Playwright verification
function checkQaReport(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const issues = {};
    for (const [flag, patterns] of Object.entries(QA_SIGNALS)) {
      issues[flag] = patterns.some((pattern) => pattern.test(content));
    }
    // Playwright Verification section (old check, still valid), or actual
    // Playwright tool calls recorded in the report.
    issues.hasPlaywrightVerification =
      /##\s*Playwright\s*Verification/i.test(content) ||
      (/mcp__playwright__browser_navigate/i.test(content) &&
        /Result:\s*(SUCCESS|Page loaded)/i.test(content));
    issues.hasForbiddenExcuse = QA_FORBIDDEN_EXCUSES.some((pattern) => pattern.test(content));
    return issues;
  } catch {
    return null;
  }
}

// CRITICAL / IMPORTANT section descriptors for the header scan. A header only
// counts when followed by actual content (not "none found" / "0 issues").
const SEVERITY_SECTIONS = [
  {
    flag: 'hasCritical',
    countKey: 'criticalCount',
    headRe: /CRITICAL/i,
    markerRe: /###|🔴|\*\*/,
    noneRe: /none\s*found|no\s*critical|no\s*issues|0\s*issues|\*\*0\*\*|:\s*0($|\s)/i,
  },
  {
    flag: 'hasImportant',
    countKey: 'importantCount',
    headRe: /IMPORTANT/i,
    markerRe: /###|🟡|\*\*/,
    noneRe: /none\s*found|no\s*important|no\s*issues|0\s*issues|\*\*0\*\*|:\s*0($|\s)/i,
  },
];

/**
 * Classify one line against one severity section:
 *   'none'   — header absent, or header present without listed content
 *   'empty'  — header followed by "none found"-style text (skip rest of line)
 *   'issues' — header followed by actual content (numbered list, bullets, …)
 */
function sectionVerdict(lines, i, section) {
  if (!section.headRe.test(lines[i]) || !section.markerRe.test(lines[i])) return 'none';
  // Check next few lines to see if there are actual issues
  const nextLines = lines
    .slice(i + 1, i + 5)
    .join(' ')
    .toLowerCase();
  if (section.noneRe.test(nextLines)) return 'empty';
  if (/^\s*[-*\d]/.test(lines[i + 1] || '') || /^\s*[-*\d]/.test(lines[i + 2] || '')) {
    return 'issues';
  }
  return 'none';
}

// Scan for CRITICAL/IMPORTANT section headers followed by actual issues.
function scanSeveritySections(lines, issues) {
  for (let i = 0; i < lines.length; i++) {
    for (const section of SEVERITY_SECTIONS) {
      const verdict = sectionVerdict(lines, i, section);
      // Legacy `continue`: an empty CRITICAL section skipped the IMPORTANT
      // check for the same line — `break` preserves that.
      if (verdict === 'empty') break;
      if (verdict === 'issues') {
        issues[section.flag] = true;
        issues[section.countKey]++;
      }
    }
  }
}

// Also check for inline critical/important issue markers
function applyInlineMarkerCounts(content, issues) {
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
}

// Check for BLOCKED tests (but not "0 BLOCKED" or "BLOCKED: 0")
function detectBlockedTests(content) {
  if (!/BLOCKED/i.test(content)) return false;
  // Make sure it's not "0 BLOCKED" or "BLOCKED: 0" or "no blocked"
  if (/0\s*BLOCKED|BLOCKED\s*:\s*0|no\s*blocked|none\s*blocked/i.test(content)) return false;
  // Check if there's a number before BLOCKED (like "2 BLOCKED")
  const blockedMatch = content.match(/(\d+)\s*BLOCKED/i);
  if (blockedMatch && parseInt(blockedMatch[1], 10) > 0) return true;
  // "tests BLOCKED" or "BLOCKED tests" or "BLOCKED (reason)"
  return /tests?\s*BLOCKED|BLOCKED\s*tests?|BLOCKED\s*\(/i.test(content);
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
      importantCount: 0,
    };

    scanSeveritySections(lines, issues);
    applyInlineMarkerCounts(content, issues);
    issues.hasBlocked = detectBlockedTests(content);
    issues.hasForbiddenExcuse = CR_FORBIDDEN_EXCUSES.some((pattern) => pattern.test(content));
    // Check if it claims to be APPROVED despite issues
    issues.claimsApproved = /APPROVED/i.test(content) || /Status:\s*PASS/i.test(content);

    return issues;
  } catch {
    return null;
  }
}

module.exports = {
  checkCodeReview,
  checkQaReport,
  findCodeReviewForTask,
  findQaReportsForTask,
};
