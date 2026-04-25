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
// Status normalization — maps raw values to canonical statuses.
// Base aliases apply to all types; type-specific overrides extend them.
// ---------------------------------------------------------------------------
const BASE_ALIASES = Object.create(null);
BASE_ALIASES['APPROVED'] = 'APPROVED';
BASE_ALIASES['PASS'] = 'APPROVED';
BASE_ALIASES['PASSED'] = 'APPROVED';
BASE_ALIASES['SUCCESS'] = 'APPROVED';
BASE_ALIASES['NEEDS_WORK'] = 'NEEDS_WORK';
BASE_ALIASES['FAIL'] = 'NEEDS_WORK';
BASE_ALIASES['FAILED'] = 'NEEDS_WORK';
BASE_ALIASES['INCOMPLETE'] = 'NEEDS_WORK';
BASE_ALIASES['PENDING'] = 'NEEDS_WORK';
BASE_ALIASES['NOT_APPLICABLE'] = 'NOT_APPLICABLE';

// Per-type alias maps — only 'completion' accepts COMPLETE/DELIVERED as APPROVED.
// tests and codeReview must use explicit APPROVED.
const TYPE_ALIASES = Object.create(null);
TYPE_ALIASES['completion'] = Object.assign(Object.create(null), BASE_ALIASES, {
  COMPLETE: 'APPROVED',
  DELIVERED: 'APPROVED',
});
// Fallback for types without overrides
const STATUS_ALIASES = BASE_ALIASES;

/**
 * Resolve a raw status string to a canonical status, scoped by report type.
 * @param {string} raw - uppercase raw status value
 * @param {string} [type] - report type for type-specific aliases
 * @returns {string|undefined}
 */
function resolveAlias(raw, type) {
  const typeMap = type && TYPE_ALIASES[type];
  if (typeMap && typeMap[raw] !== undefined) return typeMap[raw];
  return STATUS_ALIASES[raw];
}

// ---------------------------------------------------------------------------
// Per-type marker patterns (migrated from check-generate-summary.js)
// Uses Object.create(null) for all lookup maps per project convention.
// ---------------------------------------------------------------------------
const TYPE_CHECKS = Object.create(null);

TYPE_CHECKS['tests'] = Object.create(null);
TYPE_CHECKS['tests'].fail = [
  '❌ FAIL',
  'NEEDS_WORK',
  '(?:^|\\n)(?:ℹ\\s*)?fail(?:ed)?\\s+[1-9]\\d*',
];
TYPE_CHECKS['tests'].pass = ['✅ PASS', '\\bAPPROVED\\b', '\\bAll\\b.*\\bpass'];

TYPE_CHECKS['codeReview'] = Object.create(null);
TYPE_CHECKS['codeReview'].fail = ['(?<!No )CRITICAL(?!\\s*ISSUES?)\\b', 'NEEDS_WORK'];
TYPE_CHECKS['codeReview'].pass = ['\\bAPPROVED\\b', '\\bNo critical\\b', '\\bNo issues\\b'];

TYPE_CHECKS['qa'] = Object.create(null);
TYPE_CHECKS['qa'].fail = [
  '❌ FAIL',
  'FAILED:\\s*[1-9]',
  'failures:\\s*[1-9]',
  'Status:\\s*FAIL',
  'Status:\\s*NEEDS_WORK',
];
TYPE_CHECKS['qa'].pass = [
  '✅ PASS',
  '\\bAll tests passed\\b',
  '\\bSUCCESS\\b',
  'Status:\\s*APPROVED',
];

TYPE_CHECKS['completion'] = Object.create(null);
TYPE_CHECKS['completion'].fail = ['\\bINCOMPLETE\\b', '\\bPENDING\\b'];
TYPE_CHECKS['completion'].pass = ['\\bCOMPLETE\\b', '\\bDELIVERED\\b'];

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
 * @param {string} [type] - report type for type-scoped alias resolution
 * @returns {string|null}
 */
function checkStatusLine(content, type) {
  // Match Status: at start of line (^ with multiline) to avoid matching
  // Status: mentions inside prose or bullet points. Return the FIRST
  // recognized match — the top-level declaration is authoritative, and
  // later Status: tokens in embedded output should not override it.
  const re = /^\s*\*{0,2}Status:\*{0,2}\s*\*{0,2}\s*([A-Z_]+)\s*\*{0,2}/gim;
  let match;
  while ((match = re.exec(content)) !== null) {
    const raw = match[1].toUpperCase();
    const resolved = resolveAlias(raw, type);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Check for status in a markdown summary table.
 * Matches: | Status | APPROVED |
 * @param {string} content
 * @param {string} [type] - report type for type-scoped alias resolution
 * @returns {string|null}
 */
function checkSummaryTable(content, type) {
  const match = content.match(/\|\s*Status\s*\|\s*\*{0,2}([A-Z_]+)\*{0,2}\s*\|/i);
  if (!match) return null;
  const raw = match[1].toUpperCase();
  return resolveAlias(raw, type) || null;
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
 * Resolution priority (matches implementation order):
 *   1. Infrastructure failures (QA only)
 *   2. Explicit Status: line (first match, authoritative when present)
 *   3. Summary table with status column
 *   4. Fail markers (type-specific heuristics, only when no explicit status)
 *   5. Pass markers (type-specific heuristics)
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

  // 2. Explicit Status: line — authoritative when present (overrides raw content patterns)
  const lineStatus = checkStatusLine(content, type);
  if (lineStatus) {
    return { status: lineStatus, icon: ICONS[lineStatus] || ICONS['UNKNOWN'] };
  }

  // 3. Summary table
  const tableStatus = checkSummaryTable(content, type);
  if (tableStatus) {
    return { status: tableStatus, icon: ICONS[tableStatus] || ICONS['UNKNOWN'] };
  }

  // 4. Fail markers (only when no explicit Status line — raw content heuristic)
  const failStatus = checkFailMarkers(content, type);
  if (failStatus) {
    return { status: failStatus, icon: ICONS[failStatus] };
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
    const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1].index : replyContent.length;
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

// Guard filter: reject spurious bold words that are not real issue titles.
// Mirrors the guard in work-suggestion-replies.js (lines 109-115).
// Guard: reject template phrases and section keywords, but not real issue titles
// starting with "No" (e.g., "No error handling in foo()" is a legitimate issue).
const SPURIOUS_TITLE_RE =
  /^(none|n\/a|no\s+issues?\s*$|no\s+issues?\s+found|no\s+critical\s+issues?|no\s+important\s+issues?|none\s+found|issues?\s*found|CRITICAL|IMPORTANT|NICE-TO-HAVE|SUGGESTIONS?)/i;
// Matches common field labels with optional trailing colon (e.g., "File", "File:")
// Also includes "Note" to avoid treating "**Note:** something" as an issue title.
const FIELD_LABEL_RE =
  /^(File|Description|Impact|Recommendation|Decision|Reason|Status|Summary|Details|Category|Severity|Priority|Suggestion|Evidence|Location|Context|Resolution|Type|Source|Line|Path|Note|Example|Output|Result|Action|Fix|Cause|Root Cause):?$/i;

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
      // Strip trailing colon before guard checks so "File:" matches FIELD_LABEL_RE
      const normalizedTitle = title.replace(/:$/, '');
      if (
        title &&
        title.length > 2 &&
        !SPURIOUS_TITLE_RE.test(title) &&
        !FIELD_LABEL_RE.test(normalizedTitle) &&
        !titles.includes(title)
      ) {
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
  // Empty/missing report cannot be considered resolved — callers should not
  // bypass the gate on an empty code-review.check.md just because a reply exists.
  if (!reportContent || !reportContent.trim()) {
    return { resolved: false, unaddressed: ['(empty report content)'] };
  }

  // Extract CRITICAL and IMPORTANT issue titles from the report.
  // Supports two formats:
  //   1. Section-based: "## CRITICAL ISSUES" with bold issue titles inside
  //   2. Heading-based: "### CRITICAL: Title" / "### IMPORTANT: Title" (inline titles)
  const criticalMatch = reportContent.match(CRITICAL_SECTION_RE);
  const importantMatch = reportContent.match(IMPORTANT_SECTION_RE);

  const criticalTitles = extractIssueTitles(criticalMatch ? criticalMatch[1] : '');
  const importantTitles = extractIssueTitles(importantMatch ? importantMatch[1] : '');

  // Also extract inline heading-based issues (### CRITICAL: Title / ### IMPORTANT: Title)
  const INLINE_CRITICAL_RE = /###?\s*(?:🔴\s*)?CRITICAL:\s*(.+)/gi;
  const INLINE_IMPORTANT_RE = /###?\s*(?:🟡\s*)?IMPORTANT:\s*(.+)/gi;
  let inlineMatch;
  while ((inlineMatch = INLINE_CRITICAL_RE.exec(reportContent)) !== null) {
    const title = inlineMatch[1].trim();
    if (title && !criticalTitles.includes(title)) criticalTitles.push(title);
  }
  while ((inlineMatch = INLINE_IMPORTANT_RE.exec(reportContent)) !== null) {
    const title = inlineMatch[1].trim();
    if (title && !importantTitles.includes(title)) importantTitles.push(title);
  }

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
    decisionByTitle[
      d.title
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .trim()
    ] = d;
  }

  // Check each blocking issue
  const unaddressed = [];
  for (const title of allBlockingTitles) {
    const normalized = title
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .trim();
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
