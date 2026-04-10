/**
 * Tests for getReportStatus in check-generate-summary.js
 *
 * Covers the false NEEDS_WORK bug (GH-80): broad 'failed' pattern in
 * statusChecks.tests.fail matched test names describing failure scenarios,
 * causing false NEEDS_WORK on passing test suites.
 *
 * Uses node:test + node:assert/strict (project convention).
 * Run: node --test hooks/__tests__/check-generate-summary.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { getReportStatus } = require('../hooks/check-generate-summary.js');

describe('getReportStatus', () => {
  // ── Basic status detection ───────────────────────────────────────────────

  it('returns APPROVED for test report with ✅ PASS', () => {
    const result = getReportStatus('## Results\n✅ PASS\nAll tests passed.', 'tests');
    assert.equal(result.status, 'APPROVED');
  });

  it('returns NEEDS_WORK for test report with ❌ FAIL and fail count > 0', () => {
    const result = getReportStatus('❌ FAIL\nfail 3\nSome tests failed.', 'tests');
    assert.equal(result.status, 'NEEDS_WORK');
  });

  it('returns APPROVED for QA report with ✅ PASS', () => {
    const result = getReportStatus('✅ PASS - All scenarios passed', 'qa');
    assert.equal(result.status, 'APPROVED');
  });

  // ── Core bug fix: false positives from broad patterns ────────────────────

  it('returns APPROVED when "failed" appears in test names but ✅ PASS is present (GH-80)', () => {
    const content = [
      '## Test Results',
      '✅ PASS',
      '',
      '- ✓ should handle failed login gracefully',
      '- ✓ should show error when payment failed',
      '- ✓ failed upload retries correctly',
      '',
      'fail 0',
      'pass 15',
    ].join('\n');

    const result = getReportStatus(content, 'tests');
    assert.equal(
      result.status,
      'APPROVED',
      'Should not match "failed" in test names when ✅ PASS is present'
    );
  });

  it('returns APPROVED when "FAILED" appears in QA scenario names but SUCCESS is present (GH-80)', () => {
    const content = [
      '## QA Report',
      'SUCCESS',
      '',
      'Scenario: User sees FAILED status and retries',
      'Scenario: FAILED payment shows proper error',
      '',
      'All tests passed.',
    ].join('\n');

    const result = getReportStatus(content, 'qa');
    assert.equal(
      result.status,
      'APPROVED',
      'Should not match "FAILED" in scenario names when SUCCESS is present'
    );
  });

  // ── fail 0 should NOT trigger NEEDS_WORK ─────────────────────────────────

  it('does not trigger NEEDS_WORK for "fail 0"', () => {
    const content = 'Tests complete\nfail 0\npass 10';
    const result = getReportStatus(content, 'tests');
    // fail 0 should not match the fail pattern; no pass marker either → UNKNOWN
    assert.notEqual(result.status, 'NEEDS_WORK', '"fail 0" must not trigger NEEDS_WORK');
  });

  // ── QA "Failed: 0" / "Failures: 0" should NOT trigger NEEDS_WORK ────────

  it('does not trigger NEEDS_WORK for QA "Failed: 0" summary line', () => {
    const content = '## QA Report\nSUCCESS\n- Passed: 5\n- Failed: 0\n- Skipped: 0';
    const result = getReportStatus(content, 'qa');
    assert.equal(
      result.status,
      'APPROVED',
      '"Failed: 0" in QA summary must not trigger NEEDS_WORK'
    );
  });

  it('does not trigger NEEDS_WORK for QA "failures: 0"', () => {
    const content = 'QA complete\nfailures: 0\npasses: 10';
    const result = getReportStatus(content, 'qa');
    assert.notEqual(result.status, 'NEEDS_WORK', '"failures: 0" must not trigger NEEDS_WORK');
  });

  it('triggers NEEDS_WORK for QA "Failed: 3"', () => {
    const content = '## QA Report\n- Passed: 2\n- Failed: 3';
    const result = getReportStatus(content, 'qa');
    assert.equal(result.status, 'NEEDS_WORK', '"Failed: 3" should trigger NEEDS_WORK');
  });

  it('triggers NEEDS_WORK for QA "Status: FAIL" (matches check-validate-reports.js)', () => {
    const content = '## QA Report\nStatus: FAIL\nSome tests failed';
    const result = getReportStatus(content, 'qa');
    assert.equal(
      result.status,
      'NEEDS_WORK',
      '"Status: FAIL" should trigger NEEDS_WORK to align with validator'
    );
  });

  // ── Null and empty content ───────────────────────────────────────────────

  it('returns MISSING for null content', () => {
    const result = getReportStatus(null, 'tests');
    assert.equal(result.status, 'MISSING');
  });

  it('returns MISSING for empty string (falsy in JS)', () => {
    const result = getReportStatus('', 'tests');
    assert.equal(result.status, 'MISSING');
  });

  // ── Unknown type ─────────────────────────────────────────────────────────

  it('returns UNKNOWN for unknown type', () => {
    const result = getReportStatus('some content', 'nonexistent');
    assert.equal(result.status, 'UNKNOWN');
  });

  // ── Explicit markers ─────────────────────────────────────────────────────

  it('returns NEEDS_WORK when NEEDS_WORK is an explicit marker in test content', () => {
    const result = getReportStatus('Overall: NEEDS_WORK\nPlease fix issues.', 'tests');
    assert.equal(result.status, 'NEEDS_WORK');
  });

  // ── Fail-first evaluation: explicit fail markers take precedence ──────────

  it('returns NEEDS_WORK when both pass and fail markers are present (fail-first)', () => {
    const content = '✅ PASS\n❌ FAIL\nSome mixed signals';
    const result = getReportStatus(content, 'tests');
    assert.equal(
      result.status,
      'NEEDS_WORK',
      'Fail markers should take precedence over pass markers to avoid false negatives'
    );
  });
});
