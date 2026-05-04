'use strict';

const { resolveAlias, STATUS_LINE_RE } = require('./parse-report-status');

// Valid statuses per report type (Object.create(null) per project convention)
const VALID_STATUSES = Object.create(null);
VALID_STATUSES['tests'] = ['APPROVED', 'NEEDS_WORK', 'NOT_APPLICABLE'];
VALID_STATUSES['codeReview'] = ['APPROVED', 'NEEDS_WORK', 'NOT_APPLICABLE'];
VALID_STATUSES['completion'] = ['APPROVED', 'NEEDS_WORK', 'NOT_APPLICABLE']; // COMPLETE/INCOMPLETE resolve via aliases

// Human-readable valid values per type (includes aliases for user guidance)
const VALID_VALUES = Object.create(null);
VALID_VALUES['completion'] = ['APPROVED', 'NEEDS_WORK', 'COMPLETE', 'INCOMPLETE', 'NOT_APPLICABLE'];
VALID_VALUES['tests'] = ['APPROVED', 'NEEDS_WORK', 'PASS', 'PASSED', 'FAIL', 'FAILED', 'NOT_APPLICABLE'];
VALID_VALUES['codeReview'] = ['APPROVED', 'NEEDS_WORK', 'PASS', 'PASSED', 'FAIL', 'FAILED', 'NOT_APPLICABLE'];

/**
 * Get human-readable valid status values for a report type.
 * @param {string} reportType
 * @returns {string[]}
 */
function getValidStatusValues(reportType) {
  return VALID_VALUES[reportType] || ['APPROVED', 'NEEDS_WORK', 'NOT_APPLICABLE'];
}

/**
 * Validate that check report content contains a valid Status: line.
 *
 * Fail-open: returns { valid: true } for null/undefined/non-string content
 * or when an internal error occurs.
 *
 * @param {string|null|undefined} content - Report file content
 * @param {string} reportType - One of 'tests', 'codeReview', 'completion'
 * @returns {{ valid: boolean, message?: string }}
 */
function validateCheckReportStatus(content, reportType) {
  try {
    if (content === null || content === undefined || typeof content !== 'string') return { valid: true }; // fail-open for null/undefined/non-string
    // Empty string is treated as missing Status (not fail-open) — check-gate blocks empty reports

    const match = content.match(STATUS_LINE_RE);
    if (!match) {
      const validValues = getValidStatusValues(reportType);
      return {
        valid: false,
        message: `BLOCKED: Report content must contain a Status: line.\n` +
          `Expected format: Status: <VALUE> or **Status:** <VALUE>\n` +
          `Valid values for ${reportType} reports: ${validValues.join(', ')}\n` +
          `Example: Status: APPROVED`,
      };
    }

    const raw = match[1].toUpperCase();
    const resolved = resolveAlias(raw, reportType);
    if (!resolved) {
      const validValues = getValidStatusValues(reportType);
      return {
        valid: false,
        message: `BLOCKED: Status value "${raw}" is not valid for ${reportType} reports.\n` +
          `Valid values: ${validValues.join(', ')}`,
      };
    }

    return { valid: true };
  } catch {
    return { valid: true }; // fail-open on errors
  }
}

module.exports = { validateCheckReportStatus };
