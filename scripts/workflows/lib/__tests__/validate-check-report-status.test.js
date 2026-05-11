/**
 * Tests for workflows/lib/validate-check-report-status.js
 *
 * GH-326 Task 1.1: Validator that checks Status: line presence in check reports.
 * These tests are written BEFORE the production code (RED phase).
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validateCheckReportStatus } = require('../validate-check-report-status');

// ---------------------------------------------------------------------------
// Valid Status lines per report type
// ---------------------------------------------------------------------------
describe('validateCheckReportStatus — valid Status lines', () => {
  it('accepts "Status: APPROVED" for tests type', () => {
    const result = validateCheckReportStatus('Status: APPROVED\n# Test Report', 'tests');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('accepts "Status: NEEDS_WORK" for tests type', () => {
    const result = validateCheckReportStatus('Status: NEEDS_WORK\n# Test Report', 'tests');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('accepts "Status: APPROVED" for codeReview type', () => {
    const result = validateCheckReportStatus('Status: APPROVED\n# Code Review', 'codeReview');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('accepts "Status: NEEDS_WORK" for codeReview type', () => {
    const result = validateCheckReportStatus('Status: NEEDS_WORK\n# Code Review', 'codeReview');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('accepts "Status: COMPLETE" for completion type', () => {
    const result = validateCheckReportStatus('Status: COMPLETE\n# Completion Report', 'completion');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('accepts "Status: INCOMPLETE" for completion type', () => {
    const result = validateCheckReportStatus(
      'Status: INCOMPLETE\n# Completion Report',
      'completion'
    );
    assert.deepStrictEqual(result, { valid: true });
  });

  it('accepts "Status: APPROVED" for completion type (base alias)', () => {
    const result = validateCheckReportStatus('Status: APPROVED\n# Completion Report', 'completion');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('accepts "Status: PASS" as alias for APPROVED for tests type', () => {
    const result = validateCheckReportStatus('Status: PASS\n# Test Report', 'tests');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('accepts "Status: FAIL" as alias for NEEDS_WORK for tests type', () => {
    const result = validateCheckReportStatus('Status: FAIL\n# Test Report', 'tests');
    assert.deepStrictEqual(result, { valid: true });
  });
});

// ---------------------------------------------------------------------------
// Missing Status line
// ---------------------------------------------------------------------------
describe('validateCheckReportStatus — missing Status line', () => {
  it('returns valid: false when no Status line exists', () => {
    const result = validateCheckReportStatus('# Test Report\nAll tests pass', 'tests');
    assert.equal(result.valid, false);
    assert.ok(result.message, 'should include an error message');
    assert.ok(result.message.includes('Status:'), 'message should mention Status:');
  });

  it('returns valid: false for content with only prose', () => {
    const result = validateCheckReportStatus(
      '# Code Review\n\nLooks good to me.\n\nNo issues found.',
      'codeReview'
    );
    assert.equal(result.valid, false);
    assert.ok(result.message);
  });

  it('error message lists valid statuses for the report type', () => {
    const result = validateCheckReportStatus('# Test Report\nAll tests pass', 'tests');
    assert.equal(result.valid, false);
    assert.ok(result.message.includes('APPROVED'), 'should list APPROVED as valid');
  });

  it('error message lists COMPLETE for completion type', () => {
    const result = validateCheckReportStatus('# Completion Report', 'completion');
    assert.equal(result.valid, false);
    assert.ok(result.message.includes('COMPLETE'), 'should list COMPLETE as valid for completion');
  });
});

// ---------------------------------------------------------------------------
// Invalid status for type
// ---------------------------------------------------------------------------
describe('validateCheckReportStatus — invalid status for type', () => {
  it('returns valid: false for Status: COMPLETE on tests type', () => {
    const result = validateCheckReportStatus('Status: COMPLETE\n# Test Report', 'tests');
    assert.equal(result.valid, false);
    assert.ok(result.message, 'should include error message');
  });

  it('returns valid: false for Status: COMPLETE on codeReview type', () => {
    const result = validateCheckReportStatus('Status: COMPLETE\n# Code Review', 'codeReview');
    assert.equal(result.valid, false);
  });

  it('returns valid: false for Status: SUCCESS on tests type', () => {
    const result = validateCheckReportStatus('Status: SUCCESS\n# Test Report', 'tests');
    assert.equal(result.valid, false);
  });

  it('returns valid: false for Status: GIBBERISH on any type', () => {
    const result = validateCheckReportStatus('Status: GIBBERISH\n# Report', 'tests');
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// Freeform status words without "Status:" prefix
// ---------------------------------------------------------------------------
describe('validateCheckReportStatus — freeform status words (no Status: prefix)', () => {
  it('returns valid: false for standalone "APPROVED" without Status: prefix', () => {
    const result = validateCheckReportStatus('# Code Review\n\nAPPROVED\nLooks good', 'codeReview');
    assert.equal(result.valid, false);
  });

  it('returns valid: false for standalone "**APPROVED**" without Status: prefix', () => {
    const result = validateCheckReportStatus(
      '# Code Review\n\n**APPROVED**\nLooks good',
      'codeReview'
    );
    assert.equal(result.valid, false);
  });

  it('returns valid: false for "Overall Assessment: Approved" without Status: prefix', () => {
    const result = validateCheckReportStatus(
      '# Code Review\n\nOverall Assessment: Approved\nDetails...',
      'codeReview'
    );
    assert.equal(result.valid, false);
  });

  it('returns valid: false for "Result: COMPLETE" without Status: prefix', () => {
    const result = validateCheckReportStatus(
      '# Completion Report\n\nResult: COMPLETE\nAll done.',
      'completion'
    );
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// Bold markdown variants with Status: prefix
// ---------------------------------------------------------------------------
describe('validateCheckReportStatus — bold markdown variants', () => {
  it('accepts "**Status:** APPROVED"', () => {
    const result = validateCheckReportStatus('**Status:** APPROVED\n# Report', 'tests');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('accepts "**Status:** **APPROVED**"', () => {
    const result = validateCheckReportStatus('**Status:** **APPROVED**\n# Report', 'tests');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('accepts "**Status:** **COMPLETE**" for completion type', () => {
    const result = validateCheckReportStatus('**Status:** **COMPLETE**\n# Report', 'completion');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('accepts Status: line with leading whitespace', () => {
    const result = validateCheckReportStatus('  Status: APPROVED\n# Report', 'tests');
    assert.deepStrictEqual(result, { valid: true });
  });
});

// ---------------------------------------------------------------------------
// Fail-open on errors (null/undefined input)
// ---------------------------------------------------------------------------
describe('validateCheckReportStatus — fail-open on errors', () => {
  it('returns valid: true for null content', () => {
    const result = validateCheckReportStatus(null, 'tests');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('returns valid: true for undefined content', () => {
    const result = validateCheckReportStatus(undefined, 'tests');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('returns valid: true for non-string content', () => {
    const result = validateCheckReportStatus(42, 'tests');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('returns valid: true for null reportType', () => {
    const result = validateCheckReportStatus('Status: APPROVED', null);
    assert.deepStrictEqual(result, { valid: true });
  });
});
