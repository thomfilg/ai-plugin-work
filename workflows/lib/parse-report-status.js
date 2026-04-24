'use strict';

const AppAccessStatus = require('../check/lib/app-access-status');

// ---------------------------------------------------------------------------
// Icons — keyed by normalized status (Object.create(null) per convention)
// ---------------------------------------------------------------------------
const ICONS = Object.create(null);
ICONS['APPROVED'] = '✅';
ICONS['NEEDS_WORK'] = '⚠️';
ICONS['MISSING'] = '❓';
ICONS['NOT_APPLICABLE'] = '➖';
ICONS['UNKNOWN'] = '❓';
ICONS['INFRASTRUCTURE_FAILURE'] = '🛑';
ICONS['ACCESS_FAILED'] = '🔒';

// ---------------------------------------------------------------------------
// Status normalization — maps raw values to canonical statuses
// ---------------------------------------------------------------------------
const STATUS_ALIASES = Object.create(null);
STATUS_ALIASES['APPROVED'] = 'APPROVED';
STATUS_ALIASES['COMPLETE'] = 'APPROVED';
STATUS_ALIASES['DELIVERED'] = 'APPROVED';
STATUS_ALIASES['PASS'] = 'APPROVED';
STATUS_ALIASES['PASSED'] = 'APPROVED';
STATUS_ALIASES['SUCCESS'] = 'APPROVED';
STATUS_ALIASES['NEEDS_WORK'] = 'NEEDS_WORK';
STATUS_ALIASES['FAIL'] = 'NEEDS_WORK';
STATUS_ALIASES['FAILED'] = 'NEEDS_WORK';
STATUS_ALIASES['INCOMPLETE'] = 'NEEDS_WORK';
STATUS_ALIASES['PENDING'] = 'NEEDS_WORK';
STATUS_ALIASES['NOT_APPLICABLE'] = 'NOT_APPLICABLE';

// ---------------------------------------------------------------------------
// Per-type marker patterns (migrated from check-generate-summary.js)
// Uses Object.create(null) for all lookup maps per project convention.
// ---------------------------------------------------------------------------
const TYPE_CHECKS = Object.create(null);

TYPE_CHECKS['tests'] = Object.create(null);
TYPE_CHECKS['tests'].fail = ['❌ FAIL', 'NEEDS_WORK', 'fail [1-9]\\d*'];
TYPE_CHECKS['tests'].pass = ['✅ PASS', 'APPROVED', 'All.*pass'];

TYPE_CHECKS['codeReview'] = Object.create(null);
TYPE_CHECKS['codeReview'].fail = ['(?<!No )CRITICAL(?! ISSUES?)\\b', 'NEEDS_WORK'];
TYPE_CHECKS['codeReview'].pass = ['APPROVED', 'No critical', 'No issues'];

TYPE_CHECKS['qa'] = Object.create(null);
TYPE_CHECKS['qa'].fail = [
  '❌ FAIL',
  'FAILED:\\s*[1-9]',
  'failures:\\s*[1-9]',
  'Status:\\s*FAIL',
  'Status:\\s*NEEDS_WORK',
];
TYPE_CHECKS['qa'].pass = ['✅ PASS', 'All tests passed', 'SUCCESS', 'Status:\\s*APPROVED'];

TYPE_CHECKS['completion'] = Object.create(null);
TYPE_CHECKS['completion'].fail = ['INCOMPLETE', 'PENDING'];
TYPE_CHECKS['completion'].pass = ['COMPLETE', 'DELIVERED'];

// ---------------------------------------------------------------------------
// Format checkers — each returns a normalized status string or null
// ---------------------------------------------------------------------------

/**
 * Check for QA-specific infrastructure/access failures.
 * Only applies to 'qa' type reports.
 * @param {string} content
 * @param {string} type
 * @returns {string|null}
 */
function checkInfrastructureFailure(content, type) {
  if (type !== 'qa') return null;
  if (
    content.includes('INFRASTRUCTURE_FAILURE') ||
    content.includes('PLAYWRIGHT_UNAVAILABLE') ||
    content.includes('PLAYWRIGHT UNAVAILABLE')
  ) {
    return 'INFRASTRUCTURE_FAILURE';
  }
  if (content.includes(AppAccessStatus.ACCESS_FAILED)) {
    return 'ACCESS_FAILED';
  }
  return null;
}

/**
 * Check for type-specific fail markers.
 * Fail markers are checked first to enforce fail-first precedence (R10).
 * @param {string} content
 * @param {string} type
 * @returns {string|null}
 */
function checkFailMarkers(content, type) {
  const checks = TYPE_CHECKS[type];
  if (!checks) return null;
  for (const pattern of checks.fail) {
    if (new RegExp(pattern, 'i').test(content)) {
      return 'NEEDS_WORK';
    }
  }
  return null;
}

/**
 * Check for explicit Status: line (with optional bold markdown).
 * Matches: Status: APPROVED, **Status:** **APPROVED**, **Status:** APPROVED
 * @param {string} content
 * @returns {string|null}
 */
function checkStatusLine(content) {
  const match = content.match(
    /\*{0,2}Status:?\*{0,2}\s*\*{0,2}\s*([A-Z_]+)\s*\*{0,2}/i
  );
  if (!match) return null;
  const raw = match[1].toUpperCase();
  return STATUS_ALIASES[raw] || null;
}

/**
 * Check for status in a markdown summary table.
 * Matches: | Status | APPROVED |
 * @param {string} content
 * @returns {string|null}
 */
function checkSummaryTable(content) {
  const match = content.match(
    /\|\s*Status\s*\|\s*\*{0,2}([A-Z_]+)\*{0,2}\s*\|/i
  );
  if (!match) return null;
  const raw = match[1].toUpperCase();
  return STATUS_ALIASES[raw] || null;
}

/**
 * Check for type-specific pass markers.
 * @param {string} content
 * @param {string} type
 * @returns {string|null}
 */
function checkPassMarkers(content, type) {
  const checks = TYPE_CHECKS[type];
  if (!checks) return null;
  for (const pattern of checks.pass) {
    if (new RegExp(pattern, 'i').test(content)) {
      return 'APPROVED';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse the status from report file content.
 *
 * Format priority:
 *   1. Infrastructure failures (QA only)
 *   2. Fail markers (type-specific, fail-first precedence per R10)
 *   3. Status: line with optional bold markdown
 *   4. Summary table with status column
 *   5. Pass markers (type-specific)
 *   6. Fallback: UNKNOWN
 *
 * @param {string|null|undefined} content - report file content
 * @param {string} type - one of 'tests', 'codeReview', 'qa', 'completion'
 * @returns {{ status: string, icon: string }}
 */
function parseReportStatus(content, type) {
  // R9: null / undefined / empty -> MISSING
  if (!content || !content.trim()) {
    return { status: 'MISSING', icon: ICONS['MISSING'] };
  }

  // 1. Infrastructure failures (QA only)
  const infraStatus = checkInfrastructureFailure(content, type);
  if (infraStatus) {
    return { status: infraStatus, icon: ICONS[infraStatus] };
  }

  // 2. Fail markers first (R10: fail-first precedence)
  const failStatus = checkFailMarkers(content, type);
  if (failStatus) {
    return { status: failStatus, icon: ICONS[failStatus] };
  }

  // 3. Status: line (plain or bold markdown)
  const lineStatus = checkStatusLine(content);
  if (lineStatus) {
    return { status: lineStatus, icon: ICONS[lineStatus] || ICONS['UNKNOWN'] };
  }

  // 4. Summary table
  const tableStatus = checkSummaryTable(content);
  if (tableStatus) {
    return { status: tableStatus, icon: ICONS[tableStatus] || ICONS['UNKNOWN'] };
  }

  // 5. Pass markers
  const passStatus = checkPassMarkers(content, type);
  if (passStatus) {
    return { status: passStatus, icon: ICONS[passStatus] };
  }

  // 6. Unknown type or no match
  return { status: 'UNKNOWN', icon: ICONS['UNKNOWN'] };
}

// ---------------------------------------------------------------------------
// Reply decision parsing — extracts Decision/Reason from code-review reply
// ---------------------------------------------------------------------------

// Regex for splitting on reply ## Issue: headers (used by parseReplyDecisions)
const REPLY_ISSUE_HEADER_RE = /^##\s+Issue:\s*(.+)$/gm;

/**
 * Parse reply file content into an array of decision objects.
 *
 * Expected format (enforced by work-suggestion-replies.js):
 *   ## Issue: [title]
 *   **Decision:** FIXED | DEFERRED | NOT_APPLICABLE
 *   **Reason:** [justification]
 *
 * @param {string|null|undefined} replyContent
 * @returns {Array<{ title: string, decision: string, reason: string }>}
 */
function parseReplyDecisions(replyContent) {
  if (!replyContent || !replyContent.trim()) return [];

  const decisions = [];
  const sectionStarts = [];

  // Collect all ## Issue: header positions
  let match;
  const re = new RegExp(REPLY_ISSUE_HEADER_RE.source, 'gm');
  while ((match = re.exec(replyContent)) !== null) {
    sectionStarts.push({ index: match.index, title: match[1].trim() });
  }

  if (sectionStarts.length === 0) return [];

  for (let i = 0; i < sectionStarts.length; i++) {
    const start = sectionStarts[i].index;
    const end =
      i + 1 < sectionStarts.length ? sectionStarts[i + 1].index : replyContent.length;
    const sectionBody = replyContent.slice(start, end);

    // Extract Decision field
    const decisionMatch = sectionBody.match(
      /\*\*Decision:\*\*\s*(FIXED|DEFERRED|NOT_APPLICABLE)\b/i
    );
    const decision = decisionMatch ? decisionMatch[1].toUpperCase() : 'UNKNOWN';

    // Extract Reason field
    const reasonMatch = sectionBody.match(/\*\*Reason:\*\*\s*(.*)/i);
    const reason = reasonMatch ? reasonMatch[1].trim() : '';

    decisions.push({
      title: sectionStarts[i].title,
      decision,
      reason,
    });
  }

  return decisions;
}

// ---------------------------------------------------------------------------
// Code-review resolution check — cross-references report issues with replies
// ---------------------------------------------------------------------------

// Patterns for extracting CRITICAL/IMPORTANT issue titles from code-review reports.
// Reuses the patterns from check-validate-reports.js (lines 149-156) and
// work-suggestion-replies.js extractAllIssues().
const CRITICAL_SECTION_RE =
  /###?\s*(?:🔴\s*)?CRITICAL\s*ISSUES?[^\n]*\n([\s\S]*?)(?=###?\s*(?:🟡|IMPORTANT|🟢|NICE-TO-HAVE|SUGGESTIONS?|---)|$)/i;
const IMPORTANT_SECTION_RE =
  /###?\s*(?:🟡\s*)?IMPORTANT\s*ISSUES?[^\n]*\n([\s\S]*?)(?=###?\s*(?:🟢|NICE-TO-HAVE|SUGGESTIONS?|---)|$)/i;

// Early-exit pattern: section says "none found" / "no issues" / "0 issues"
const NO_ISSUES_RE = /none\s*found|no\s*(critical|important|issues?)|0\s*issues/i;

// Patterns for extracting individual issue titles within a section.
// Matches: **Title**, **🔴 Title**, - **Title**: desc, 1. **Title**: desc
const ISSUE_TITLE_PATTERNS = [
  /\*\*(?:🔴|🟡|🟢)?\s*([^*\n]+)\*\*/g,
  /[-*]\s*\*\*([^*:]+)\*\*\s*:/g,
  /\d+\.\s*\*\*([^*:]+)\*\*\s*:/g,
];

/**
 * Extract issue titles from a section of the code-review report.
 * @param {string} sectionContent
 * @returns {string[]}
 */
function extractIssueTitles(sectionContent) {
  if (!sectionContent) return [];

  // Check for "none found" / "no issues" early exit
  if (NO_ISSUES_RE.test(sectionContent.substring(0, 200))) {
    return [];
  }

  const titles = [];
  for (const pattern of ISSUE_TITLE_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m;
    while ((m = re.exec(sectionContent)) !== null) {
      const title = m[1].trim();
      if (title && !titles.includes(title)) {
        titles.push(title);
      }
    }
  }
  return titles;
}

/**
 * Determine whether all CRITICAL/IMPORTANT issues in a code-review report
 * have been addressed in the reply file.
 *
 * An issue is addressed if its reply decision is:
 *   - FIXED
 *   - DEFERRED (with a non-empty reason)
 *   - NOT_APPLICABLE
 *
 * DEFERRED without a reason is treated as unaddressed (blocks).
 *
 * @param {string|null|undefined} reportContent - code-review.check.md content
 * @param {string|null|undefined} replyContent  - code-review-reply.check.md content
 * @returns {{ resolved: boolean, unaddressed: string[] }}
 */
function isCodeReviewResolved(reportContent, replyContent) {
  if (!reportContent || !reportContent.trim()) {
    return { resolved: true, unaddressed: [] };
  }

  // Extract CRITICAL and IMPORTANT issue titles from the report
  const criticalMatch = reportContent.match(CRITICAL_SECTION_RE);
  const importantMatch = reportContent.match(IMPORTANT_SECTION_RE);

  const criticalTitles = extractIssueTitles(criticalMatch ? criticalMatch[1] : '');
  const importantTitles = extractIssueTitles(importantMatch ? importantMatch[1] : '');

  const allBlockingTitles = [...criticalTitles, ...importantTitles];

  // No blocking issues -> resolved
  if (allBlockingTitles.length === 0) {
    return { resolved: true, unaddressed: [] };
  }

  // Parse reply decisions
  const decisions = parseReplyDecisions(replyContent);

  // Build a lookup of reply decisions by normalized title
  const decisionByTitle = Object.create(null);
  for (const d of decisions) {
    decisionByTitle[d.title.toLowerCase().replace(/[^\w\s]/g, '').trim()] = d;
  }

  // Check each blocking issue
  const unaddressed = [];
  for (const title of allBlockingTitles) {
    const normalized = title.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const reply = decisionByTitle[normalized];

    if (!reply) {
      unaddressed.push(title);
      continue;
    }

    const { decision, reason } = reply;
    if (decision === 'FIXED' || decision === 'NOT_APPLICABLE') {
      continue; // addressed
    }
    if (decision === 'DEFERRED' && reason && reason.trim()) {
      continue; // addressed with justification
    }

    // DEFERRED without reason, UNKNOWN, or invalid decision -> unaddressed
    unaddressed.push(title);
  }

  return {
    resolved: unaddressed.length === 0,
    unaddressed,
  };
}

module.exports = { parseReportStatus, parseReplyDecisions, isCodeReviewResolved };
