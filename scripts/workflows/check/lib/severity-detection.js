'use strict';

// ---------------------------------------------------------------------------
// Severity marker detection — pure function for line-based analysis
//
// Vocabulary aligns with parse-report-status.js (NO_ISSUES_RE, SPURIOUS_TITLE_RE)
// but operates at the line level rather than section level.
// ---------------------------------------------------------------------------

/**
 * Regex matching any severity emoji marker on a line.
 * Used as an early-exit filter before classification.
 *
 * Emoji prefix is required — text-only patterns (e.g., "CRITICAL must fix",
 * "severity critical") are intentionally out of scope. The emoji-based
 * convention is the enforced standard for this plugin's code review reports.
 */
const SEVERITY_RE = /(?:🔴\s*CRITICAL|🟡\s*IMPORTANT)/i;

/** Matches a line containing a 🔴 CRITICAL marker. */
const CRITICAL_RE = /🔴\s*CRITICAL/i;

/** Matches a line containing a 🟡 IMPORTANT marker. */
const IMPORTANT_RE = /🟡\s*IMPORTANT/i;

/**
 * Negation patterns — lines matching any of these report the *absence* of
 * issues and must not be counted as genuine findings.
 *
 * Uses `.*` to bridge emoji/severity tokens that may appear between the
 * negation keyword and the anchor word (e.g., "No 🔴 CRITICAL issues").
 *
 * The `LINE_START` prefix handles optional Markdown list markers (`- `, `* `, `> `)
 * and blockquote prefixes that commonly appear in code review report summaries.
 */
const LINE_START = /^\s*(?:[-*>]+\s+)*/.source;

const NEGATION_PATTERNS = [
  new RegExp(`${LINE_START}no\\s+remaining\\b`, 'i'),
  new RegExp(`${LINE_START}\\bno\\b.*\\bissues\\b`, 'i'),
  new RegExp(`${LINE_START}0\\s+.*(?:critical|important)\\b`, 'i'),
  new RegExp(`${LINE_START}none\\s+found\\b`, 'i'),
  new RegExp(`${LINE_START}\\ball\\b.*\\bresolved\\b`, 'i'),
  new RegExp(`${LINE_START}\\ball\\b.*\\baddressed\\b`, 'i'),
  new RegExp(`${LINE_START}\\bno\\b.*\\bfound\\b`, 'i'),
];

/**
 * Severity justification pattern — metadata lines that explain *why* a severity
 * level was assigned, not actual findings.
 * E.g., "Severity justification: 🟡 Important because ..."
 *
 * NOTE: `**[🔴 CRITICAL] Issue Title**` is the code-checker agent's actual finding
 * format and must NOT be suppressed here — those are genuine findings.
 */
const SEVERITY_JUSTIFICATION_RE = /severity\s+justification[:\s]/i;

/** Markdown heading prefix (e.g., `###`). */
const HEADING_RE = /^\s*#{1,6}\s+/;

/**
 * Content pattern for headings that are section labels only — no issue text.
 * Matches after stripping the `#` prefix, e.g., "🔴 CRITICAL ISSUES".
 */
const HEADING_LABEL_RE = /^(?:🔴\s*)?(?:🟡\s*)?(?:CRITICAL|IMPORTANT)\s*(?:ISSUES?)?$/i;

/**
 * Determine whether a line is a section heading with no issue description.
 * E.g., "### 🔴 CRITICAL ISSUES" is a heading label, not a genuine finding.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isSectionHeading(line) {
  if (!HEADING_RE.test(line)) return false;
  const content = line.replace(HEADING_RE, '').trim();
  return HEADING_LABEL_RE.test(content);
}

/**
 * Check whether all severity markers on a line appear inside inline code spans
 * or double-quoted strings. Strips backtick-delimited and double-quoted content
 * and re-tests — if no marker remains, the line is considered a code example
 * or quoted reference, not a genuine finding.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isInsideInlineCode(line) {
  // Remove inline code spans (backtick-delimited) and quoted strings (double-quoted)
  const stripped = line.replace(/`[^`]+`/g, '').replace(/"[^"]+"/g, '');
  // If no severity marker remains after stripping, the marker was inside code/quotes
  return !SEVERITY_RE.test(stripped);
}

/**
 * Check whether a line matches any negation pattern.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isNegated(line) {
  for (const pattern of NEGATION_PATTERNS) {
    if (pattern.test(line)) return true;
  }
  return false;
}

/**
 * Detect genuine severity markers in report content.
 *
 * Splits content into lines, matches severity emoji markers per line,
 * and filters out lines matching negation patterns or section headings
 * without issue descriptions.
 *
 * @param {string} content - The report content to analyze
 * @returns {{ critical: string[], important: string[] }} Arrays of matching lines
 */
function detectSeverityMarkers(content) {
  const result = { critical: [], important: [] };

  if (!content) return result;

  const lines = content.split('\n');

  for (const line of lines) {
    // Early exit: skip lines without any severity marker
    if (!SEVERITY_RE.test(line)) continue;

    // Filter false positives: severity marker inside inline code (backticks)
    if (isInsideInlineCode(line)) continue;

    // Filter false positives: severity justification metadata lines
    if (SEVERITY_JUSTIFICATION_RE.test(line)) continue;

    // Filter false positives: negation context
    if (isNegated(line)) continue;

    // Filter false positives: section headings without issue text
    if (isSectionHeading(line)) continue;

    // Classify by severity level
    if (CRITICAL_RE.test(line)) {
      result.critical.push(line);
    }
    if (IMPORTANT_RE.test(line)) {
      result.important.push(line);
    }
  }

  return result;
}

module.exports = { detectSeverityMarkers };
