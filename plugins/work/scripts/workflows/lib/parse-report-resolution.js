'use strict';

/**
 * parse-report-resolution.js — reply-decision parsing and code-review
 * resolution checks (extracted from parse-report-status.js, which re-exports
 * this module's API for backward compatibility).
 */

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
// Intentionally diverges from work-suggestion-replies.js (lines 109-115):
//   - work-suggestion-replies filters any title starting with "no " and requires length > 3
//   - Here we only filter specific "no issues/no critical" template phrases and allow
//     titles starting with "No" when they describe real issues (e.g., "No error handling
//     in foo()"). We also allow 3-char titles like "XSS" / "NPE" that are legitimate
//     blocking findings.
const SPURIOUS_TITLE_RE =
  /^(none|n\/a|no\s+issues?\s*$|no\s+issues?\s+found|no\s+critical\s+issues?|no\s+important\s+issues?|none\s+found|issues?\s*found|CRITICAL\s*$|IMPORTANT\s*$|NICE-TO-HAVE|SUGGESTIONS?\s*$)/i;
// Matches common field labels with optional trailing colon (e.g., "File", "File:")
// Also includes "Note" to avoid treating "**Note:** something" as an issue title.
const FIELD_LABEL_RE =
  /^(File|Description|Impact|Recommendation|Decision|Reason|Status|Summary|Details|Category|Severity|Priority|Suggestion|Evidence|Location|Context|Resolution|Type|Source|Line|Path|Note|Example|Output|Result|Action|Fix|Cause|Root Cause):?$/i;

/**
 * True when a bold match is a plausible issue title (not a template phrase,
 * field label, duplicate, or too-short fragment).
 */
function isValidIssueTitle(title, titles) {
  // Strip trailing colon before guard checks so "File:" matches FIELD_LABEL_RE
  const normalizedTitle = title.replace(/:$/, '');
  return (
    Boolean(title) &&
    title.length > 2 &&
    !SPURIOUS_TITLE_RE.test(normalizedTitle) &&
    !FIELD_LABEL_RE.test(normalizedTitle) &&
    !titles.includes(title)
  );
}

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
      if (isValidIssueTitle(title, titles)) {
        titles.push(title);
      }
    }
  }
  return titles;
}

/** Collect every trimmed capture-group-1 match of `re` into `titles` (deduped). */
function collectRegexTitles(re, content, titles) {
  const rx = new RegExp(re.source, re.flags);
  let m;
  while ((m = rx.exec(content)) !== null) {
    const title = m[1].trim();
    if (title && !titles.includes(title)) titles.push(title);
  }
}

// Inline heading-based issues (### CRITICAL: Title / ### IMPORTANT: Title)
const INLINE_CRITICAL_RE = /###?\s*(?:🔴\s*)?CRITICAL:\s*(.+)/gi;
const INLINE_IMPORTANT_RE = /###?\s*(?:🟡\s*)?IMPORTANT:\s*(.+)/gi;
// "## Issues Found" list format (write-code-review.js output):
//   **[🔴 Critical] Title** or **[🟡 Important] Title**
const ISSUES_FOUND_CRITICAL_RE = /\*\*\[🔴\s*Critical\]\s*([^*\n]+)\*\*/gi;
const ISSUES_FOUND_IMPORTANT_RE = /\*\*\[🟡\s*Important\]\s*([^*\n]+)\*\*/gi;

/**
 * Extract CRITICAL and IMPORTANT issue titles from the report.
 * Supports three formats:
 *   1. Section-based: "## CRITICAL ISSUES" with bold issue titles inside
 *   2. Heading-based: "### CRITICAL: Title" / "### IMPORTANT: Title" (inline titles)
 *   3. Issues Found list: "**[🔴 Critical] Title**" / "**[🟡 Important] Title**"
 *      (canonical output of write-code-review.js under "## Issues Found")
 */
function extractBlockingTitles(reportContent) {
  const criticalMatch = reportContent.match(CRITICAL_SECTION_RE);
  const importantMatch = reportContent.match(IMPORTANT_SECTION_RE);

  const criticalTitles = extractIssueTitles(criticalMatch ? criticalMatch[1] : '');
  const importantTitles = extractIssueTitles(importantMatch ? importantMatch[1] : '');

  collectRegexTitles(INLINE_CRITICAL_RE, reportContent, criticalTitles);
  collectRegexTitles(INLINE_IMPORTANT_RE, reportContent, importantTitles);
  collectRegexTitles(ISSUES_FOUND_CRITICAL_RE, reportContent, criticalTitles);
  collectRegexTitles(ISSUES_FOUND_IMPORTANT_RE, reportContent, importantTitles);

  return [...criticalTitles, ...importantTitles];
}

/** Normalize an issue title for reply lookup (case/punctuation-insensitive). */
function normalizeIssueTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim();
}

/**
 * An issue is addressed if its reply decision is FIXED, NOT_APPLICABLE, or
 * DEFERRED with a non-empty reason. DEFERRED without a reason, UNKNOWN, or
 * an invalid decision leaves the issue unaddressed (blocks).
 */
function isReplyAddressed(reply) {
  if (!reply) return false;
  const { decision, reason } = reply;
  if (decision === 'FIXED' || decision === 'NOT_APPLICABLE') return true;
  return decision === 'DEFERRED' && Boolean(reason && reason.trim());
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
 * @returns {{ resolved: boolean, unaddressed: string[], blockingCount: number }}
 */
function isCodeReviewResolved(reportContent, replyContent) {
  // Empty/missing report cannot be considered resolved — callers should not
  // bypass the gate on an empty code-review.check.md just because a reply exists.
  if (!reportContent || !reportContent.trim()) {
    return { resolved: false, unaddressed: ['(empty report content)'], blockingCount: 0 };
  }

  const allBlockingTitles = extractBlockingTitles(reportContent);

  // No blocking issues -> resolved
  if (allBlockingTitles.length === 0) {
    return { resolved: true, unaddressed: [], blockingCount: 0 };
  }

  // Parse reply decisions and build a lookup keyed by normalized title
  const decisionByTitle = Object.create(null);
  for (const d of parseReplyDecisions(replyContent)) {
    decisionByTitle[normalizeIssueTitle(d.title)] = d;
  }

  // Check each blocking issue
  const unaddressed = allBlockingTitles.filter(
    (title) => !isReplyAddressed(decisionByTitle[normalizeIssueTitle(title)])
  );

  return {
    resolved: unaddressed.length === 0,
    unaddressed,
    blockingCount: allBlockingTitles.length,
  };
}

module.exports = { parseReplyDecisions, isCodeReviewResolved };
