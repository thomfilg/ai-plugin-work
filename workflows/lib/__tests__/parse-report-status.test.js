/**
 * Tests for workflows/lib/parse-report-status.js — shared report status parsing.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseReportStatus,
  parseReplyDecisions,
  isCodeReviewResolved,
} = require('../parse-report-status');

// ---------------------------------------------------------------------------
// R9: null / undefined / empty content -> MISSING
// ---------------------------------------------------------------------------
describe('parseReportStatus — null safety (R9)', () => {
  it('returns MISSING for null content', () => {
    const result = parseReportStatus(null, 'tests');
    assert.deepStrictEqual(result, { status: 'MISSING', icon: '❓' });
  });

  it('returns MISSING for undefined content', () => {
    const result = parseReportStatus(undefined, 'tests');
    assert.deepStrictEqual(result, { status: 'MISSING', icon: '❓' });
  });

  it('returns MISSING for empty string', () => {
    const result = parseReportStatus('', 'tests');
    assert.deepStrictEqual(result, { status: 'MISSING', icon: '❓' });
  });

  it('returns MISSING for whitespace-only string', () => {
    const result = parseReportStatus('   \n\t  ', 'tests');
    assert.deepStrictEqual(result, { status: 'MISSING', icon: '❓' });
  });
});

// ---------------------------------------------------------------------------
// R3: Status: line format (plain)
// ---------------------------------------------------------------------------
describe('parseReportStatus — Status: line format', () => {
  it('recognizes plain Status: APPROVED for tests', () => {
    const result = parseReportStatus('Status: APPROVED', 'tests');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('recognizes Status: APPROVED with leading whitespace', () => {
    const result = parseReportStatus('  Status:   APPROVED  ', 'tests');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('recognizes Status: COMPLETE for completion type', () => {
    const result = parseReportStatus('Status: COMPLETE', 'completion');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('does NOT accept Status: COMPLETE for tests type (type-scoped aliases)', () => {
    const result = parseReportStatus('Status: COMPLETE', 'tests');
    // COMPLETE is not a valid alias for tests — should fall through to UNKNOWN
    assert.notEqual(result.status, 'APPROVED');
  });

  it('does NOT accept Status: COMPLETE for codeReview type', () => {
    const result = parseReportStatus('Status: COMPLETE', 'codeReview');
    assert.notEqual(result.status, 'APPROVED');
  });

  it('does NOT fall through to heuristics when Status line has unrecognized value', () => {
    // Status: COMPLETE is invalid for tests type. Even though ✅ PASS marker
    // exists in the body, the explicit Status: line should prevent heuristic fallback.
    const content = 'Status: COMPLETE\n\n✅ PASS\nAll tests passed';
    const result = parseReportStatus(content, 'tests');
    assert.equal(result.status, 'UNKNOWN', 'unrecognized Status line must block heuristic fallback');
  });

  it('stops at first Status line even when later Status lines are valid', () => {
    // Status: COMPLETE (invalid for tests) followed by Status: APPROVED
    // The first Status: line is authoritative — don't scan further.
    const content = 'Status: COMPLETE\n\nStatus: APPROVED';
    const result = parseReportStatus(content, 'tests');
    assert.equal(result.status, 'UNKNOWN', 'first invalid Status line must be authoritative');
  });

  it('returns UNKNOWN for summary table with type-invalid status', () => {
    const content = '| Status | COMPLETE |\n\n✅ PASS';
    const result = parseReportStatus(content, 'tests');
    assert.equal(result.status, 'UNKNOWN', 'type-invalid table status must block heuristic fallback');
  });

  it('recognizes Status: NEEDS_WORK', () => {
    const result = parseReportStatus('Status: NEEDS_WORK', 'codeReview');
    assert.deepStrictEqual(result, { status: 'NEEDS_WORK', icon: '❌' });
  });

  it('recognizes Status: NOT_APPLICABLE', () => {
    const result = parseReportStatus('Status: NOT_APPLICABLE', 'qa');
    assert.deepStrictEqual(result, { status: 'NOT_APPLICABLE', icon: '➖' });
  });

  it('recognizes Status: FAIL as NEEDS_WORK', () => {
    const result = parseReportStatus('Status: FAIL', 'tests');
    assert.deepStrictEqual(result, { status: 'NEEDS_WORK', icon: '❌' });
  });
});

// ---------------------------------------------------------------------------
// R3: Bold markdown format
// ---------------------------------------------------------------------------
describe('parseReportStatus — bold markdown format', () => {
  it('recognizes **Status:** **APPROVED**', () => {
    const result = parseReportStatus('**Status:** **APPROVED**', 'tests');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('recognizes **Status:** **COMPLETE** for completion', () => {
    const result = parseReportStatus('**Status:** **COMPLETE**', 'completion');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('recognizes **Status:** APPROVED (partial bold)', () => {
    const result = parseReportStatus('**Status:** APPROVED', 'tests');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });
});

// ---------------------------------------------------------------------------
// R3: Summary table format
// ---------------------------------------------------------------------------
describe('parseReportStatus — summary table format', () => {
  it('recognizes | Status | APPROVED | in a table', () => {
    const content = ['| Field | Value |', '|-------|-------|', '| Status | APPROVED |'].join('\n');
    const result = parseReportStatus(content, 'tests');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('recognizes | Status | COMPLETE | for completion', () => {
    const content = '| Status | COMPLETE |';
    const result = parseReportStatus(content, 'completion');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('recognizes | Status | NEEDS_WORK | in a table', () => {
    const content = '| Status | NEEDS_WORK |';
    const result = parseReportStatus(content, 'codeReview');
    assert.deepStrictEqual(result, { status: 'NEEDS_WORK', icon: '❌' });
  });
});

// ---------------------------------------------------------------------------
// R10: Fail-first precedence
// ---------------------------------------------------------------------------
describe('parseReportStatus — Status line priority', () => {
  it('explicit Status: APPROVED overrides CRITICAL markers in body', () => {
    const content = [
      'Status: APPROVED',
      '',
      '## Issues',
      '### CRITICAL: Memory leak in handler',
    ].join('\n');
    const result = parseReportStatus(content, 'codeReview');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('explicit Status: NEEDS_WORK is respected even with APPROVED in body', () => {
    const content = ['Status: NEEDS_WORK', '', 'Previously APPROVED items remain valid.'].join(
      '\n'
    );
    const result = parseReportStatus(content, 'codeReview');
    assert.deepStrictEqual(result, { status: 'NEEDS_WORK', icon: '❌' });
  });

  it('fail markers win when no explicit Status line exists', () => {
    const content = ['✅ PASS: 10 tests', '❌ FAIL: 2 tests'].join('\n');
    const result = parseReportStatus(content, 'tests');
    assert.deepStrictEqual(result, { status: 'NEEDS_WORK', icon: '❌' });
  });

  it('Status: APPROVED overrides fail patterns in raw test output', () => {
    const content = ['```', 'ℹ fail 16', '```', '', 'Status: APPROVED'].join('\n');
    const result = parseReportStatus(content, 'tests');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });
});

// ---------------------------------------------------------------------------
// Infrastructure failure detection (QA type)
// ---------------------------------------------------------------------------
describe('parseReportStatus — infrastructure failures', () => {
  it('detects INFRASTRUCTURE_FAILURE for QA reports', () => {
    const result = parseReportStatus('INFRASTRUCTURE_FAILURE: playwright not available', 'qa');
    assert.deepStrictEqual(result, { status: 'INFRASTRUCTURE_FAILURE', icon: '🛑' });
  });

  it('detects PLAYWRIGHT_UNAVAILABLE for QA reports', () => {
    const result = parseReportStatus('PLAYWRIGHT_UNAVAILABLE', 'qa');
    assert.deepStrictEqual(result, { status: 'INFRASTRUCTURE_FAILURE', icon: '🛑' });
  });

  it('detects ACCESS_FAILED for QA reports', () => {
    const result = parseReportStatus('ACCESS_FAILED: could not reach app', 'qa');
    assert.deepStrictEqual(result, { status: 'ACCESS_FAILED', icon: '🔒' });
  });

  it('honors explicit Status: NOT_APPLICABLE over PLAYWRIGHT_UNAVAILABLE in prose', () => {
    const content = [
      'Status: NOT_APPLICABLE',
      '',
      'QA was skipped because PLAYWRIGHT_UNAVAILABLE in this environment.',
    ].join('\n');
    const result = parseReportStatus(content, 'qa');
    assert.deepStrictEqual(result, { status: 'NOT_APPLICABLE', icon: '➖' });
  });

  it('honors explicit Status: APPROVED over INFRASTRUCTURE_FAILURE in prose', () => {
    const content = [
      'Status: APPROVED',
      '',
      'Previously saw INFRASTRUCTURE_FAILURE but retried successfully.',
    ].join('\n');
    const result = parseReportStatus(content, 'qa');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('still detects INFRASTRUCTURE_FAILURE when no explicit Status line', () => {
    const result = parseReportStatus('PLAYWRIGHT_UNAVAILABLE — cannot run tests', 'qa');
    assert.deepStrictEqual(result, { status: 'INFRASTRUCTURE_FAILURE', icon: '🛑' });
  });

  it('does NOT detect INFRASTRUCTURE_FAILURE for non-QA types', () => {
    const result = parseReportStatus('INFRASTRUCTURE_FAILURE mentioned somewhere', 'tests');
    // For tests type, INFRASTRUCTURE_FAILURE is not a recognized fail pattern
    assert.notEqual(result.status, 'INFRASTRUCTURE_FAILURE');
  });
});

// ---------------------------------------------------------------------------
// Pass marker patterns (per type)
// ---------------------------------------------------------------------------
describe('parseReportStatus — pass markers', () => {
  it('recognizes "✅ PASS" for tests type', () => {
    const result = parseReportStatus('✅ PASS: All 42 tests passed', 'tests');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('recognizes "All tests passed" for QA type', () => {
    const result = parseReportStatus('All tests passed successfully', 'qa');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('recognizes "COMPLETE" for completion type', () => {
    const result = parseReportStatus('All tasks are COMPLETE', 'completion');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('recognizes "No critical issues" for codeReview type', () => {
    const result = parseReportStatus('No critical issues found', 'codeReview');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('recognizes "No issues found" for codeReview type', () => {
    const result = parseReportStatus('No issues found in this review', 'codeReview');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });
});

// ---------------------------------------------------------------------------
// GH-232: CRITICAL section headers must not trigger fail marker
// ---------------------------------------------------------------------------
describe('parseReportStatus — CRITICAL section header false-negative (GH-232)', () => {
  it('returns APPROVED when Status: APPROVED with ## CRITICAL ISSUES header + None found', () => {
    const content = 'Status: APPROVED\n\n## CRITICAL ISSUES\nNone found.';
    const result = parseReportStatus(content, 'codeReview');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('returns APPROVED when Status: APPROVED with ### CRITICAL ISSUES header + None found', () => {
    const content = 'Status: APPROVED\n\n### CRITICAL ISSUES\nNone found.';
    const result = parseReportStatus(content, 'codeReview');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('returns APPROVED when Status: APPROVED with emoji CRITICAL header + None found', () => {
    const content = 'Status: APPROVED\n\n### 🔴 CRITICAL ISSUES\nNone found.';
    const result = parseReportStatus(content, 'codeReview');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('explicit Status: APPROVED overrides CRITICAL in body', () => {
    const content = 'Status: APPROVED\n\n## Issues\n### CRITICAL: Memory leak in handler';
    const result = parseReportStatus(content, 'codeReview');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('CRITICAL in prose triggers NEEDS_WORK when no explicit Status line', () => {
    const content = 'Found a CRITICAL bug in the parser.';
    const result = parseReportStatus(content, 'codeReview');
    assert.deepStrictEqual(result, { status: 'NEEDS_WORK', icon: '❌' });
  });
});

// ---------------------------------------------------------------------------
// GH-232: Anchored markers prevent substring false positives
// ---------------------------------------------------------------------------
describe('parseReportStatus — anchored markers prevent false positives', () => {
  it('does not treat "unsuccessful" as SUCCESS for QA type', () => {
    const result = parseReportStatus('execution was unsuccessful', 'qa');
    assert.notEqual(result.status, 'APPROVED', '"unsuccessful" must not match SUCCESS');
  });

  it('does not treat "unapproved" as APPROVED for tests type', () => {
    const result = parseReportStatus('this run is unapproved pending rerun', 'tests');
    assert.notEqual(result.status, 'APPROVED', '"unapproved" must not match APPROVED');
  });

  it('does not treat "should fail 3 times" prose as fail marker for tests type', () => {
    const content = 'Status: APPROVED\n\nTest description: should fail 3 times before succeeding';
    const result = parseReportStatus(content, 'tests');
    assert.equal(result.status, 'APPROVED', 'inline prose "fail 3" must not override Status line');
  });

  it('does not treat "No issues were fixed yet" as pass for codeReview', () => {
    const result = parseReportStatus('No issues were fixed yet', 'codeReview');
    assert.notEqual(
      result.status,
      'APPROVED',
      '"No issues were fixed yet" must not match pass marker'
    );
  });

  it('does not treat "no success was achieved" as pass for QA', () => {
    const result = parseReportStatus('no success was achieved in testing', 'qa');
    assert.notEqual(result.status, 'APPROVED', '"no success" must not match SUCCESS pass marker');
  });

  it('recognizes "Status: SUCCESS" for QA type', () => {
    const result = parseReportStatus('Status: SUCCESS', 'qa');
    assert.deepStrictEqual(result, { status: 'APPROVED', icon: '✅' });
  });

  it('does NOT accept "Status: SUCCESS" for tests type', () => {
    const result = parseReportStatus('Status: SUCCESS', 'tests');
    assert.equal(result.status, 'UNKNOWN', 'SUCCESS is only valid for QA type');
  });

  it('does NOT accept "Status: SUCCESS" for codeReview type', () => {
    const result = parseReportStatus('Status: SUCCESS', 'codeReview');
    assert.equal(result.status, 'UNKNOWN', 'SUCCESS is only valid for QA type');
  });

  it('recognizes "Status: INFRASTRUCTURE_FAILURE" for QA type', () => {
    const result = parseReportStatus('Status: INFRASTRUCTURE_FAILURE', 'qa');
    assert.deepStrictEqual(result, { status: 'INFRASTRUCTURE_FAILURE', icon: '🛑' });
  });

  it('recognizes "Status: ACCESS_FAILED" for QA type', () => {
    const result = parseReportStatus('Status: ACCESS_FAILED', 'qa');
    assert.deepStrictEqual(result, { status: 'ACCESS_FAILED', icon: '🔒' });
  });

  it('Status: APPROVED at top overrides later Status: FAIL in embedded output', () => {
    const content = [
      'Status: APPROVED',
      '',
      '```',
      'Status: FAIL',
      'Some embedded output',
      '```',
    ].join('\n');
    const result = parseReportStatus(content, 'tests');
    assert.equal(result.status, 'APPROVED', 'first Status line should be authoritative');
  });
});

// ---------------------------------------------------------------------------
// Unknown type / unknown content -> UNKNOWN
// ---------------------------------------------------------------------------
describe('parseReportStatus — fallback to UNKNOWN', () => {
  it('returns UNKNOWN for unrecognized type', () => {
    const result = parseReportStatus('Some content', 'unknownType');
    assert.deepStrictEqual(result, { status: 'UNKNOWN', icon: '❓' });
  });

  it('returns UNKNOWN when no patterns match', () => {
    const result = parseReportStatus('Just some random text with no status indicators', 'tests');
    assert.deepStrictEqual(result, { status: 'UNKNOWN', icon: '❓' });
  });
});

// ---------------------------------------------------------------------------
// Acceptance criteria from tasks.md
// ---------------------------------------------------------------------------
describe('parseReportStatus — acceptance criteria', () => {
  it('parseReportStatus(null, "tests") returns MISSING with "?" icon', () => {
    const result = parseReportStatus(null, 'tests');
    assert.equal(result.status, 'MISSING');
    assert.equal(result.icon, '❓');
  });

  it('parseReportStatus("Status: APPROVED", "tests") returns APPROVED', () => {
    const result = parseReportStatus('Status: APPROVED', 'tests');
    assert.equal(result.status, 'APPROVED');
    assert.equal(result.icon, '✅');
  });

  it('parseReportStatus("**Status:** **COMPLETE**", "completion") returns APPROVED', () => {
    const result = parseReportStatus('**Status:** **COMPLETE**', 'completion');
    assert.equal(result.status, 'APPROVED');
    assert.equal(result.icon, '✅');
  });

  it('explicit Status: APPROVED takes priority over CRITICAL in body for codeReview', () => {
    const content =
      'Status: APPROVED\n\n## Issues\n### CRITICAL: Unhandled error\nSome detail here.';
    const result = parseReportStatus(content, 'codeReview');
    assert.equal(result.status, 'APPROVED');
    assert.equal(result.icon, '✅');
  });

  it('exports parseReportStatus as a function', () => {
    assert.equal(typeof parseReportStatus, 'function');
  });
});

// ===========================================================================
// parseReplyDecisions — Task 2 (R1)
// ===========================================================================
describe('parseReplyDecisions — empty/null input', () => {
  it('returns empty array for null content', () => {
    assert.deepStrictEqual(parseReplyDecisions(null), []);
  });

  it('returns empty array for undefined content', () => {
    assert.deepStrictEqual(parseReplyDecisions(undefined), []);
  });

  it('returns empty array for empty string', () => {
    assert.deepStrictEqual(parseReplyDecisions(''), []);
  });

  it('returns empty array for content with no Issue sections', () => {
    assert.deepStrictEqual(parseReplyDecisions('Some random text\nNo issues here'), []);
  });
});

describe('parseReplyDecisions — single issue', () => {
  it('parses a single FIXED issue', () => {
    const content = [
      '## Issue: Memory leak in handler',
      '**Decision:** FIXED',
      '**Reason:** Refactored the handler to properly close connections.',
    ].join('\n');

    const result = parseReplyDecisions(content);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Memory leak in handler');
    assert.equal(result[0].decision, 'FIXED');
    assert.equal(result[0].reason, 'Refactored the handler to properly close connections.');
  });

  it('parses a single DEFERRED issue with reason', () => {
    const content = [
      '## Issue: Performance optimization',
      '**Decision:** DEFERRED',
      '**Reason:** Will address in follow-up ticket GH-300.',
    ].join('\n');

    const result = parseReplyDecisions(content);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Performance optimization');
    assert.equal(result[0].decision, 'DEFERRED');
    assert.equal(result[0].reason, 'Will address in follow-up ticket GH-300.');
  });

  it('parses a single NOT_APPLICABLE issue', () => {
    const content = [
      '## Issue: Missing validation on input',
      '**Decision:** NOT_APPLICABLE',
      '**Reason:** Input is already validated upstream.',
    ].join('\n');

    const result = parseReplyDecisions(content);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Missing validation on input');
    assert.equal(result[0].decision, 'NOT_APPLICABLE');
    assert.equal(result[0].reason, 'Input is already validated upstream.');
  });
});

describe('parseReplyDecisions — multiple issues', () => {
  it('parses multiple issues with mixed decisions', () => {
    const content = [
      '## Issue: SQL injection risk',
      '**Decision:** FIXED',
      '**Reason:** Added parameterized queries.',
      '',
      '## Issue: Missing error handling',
      '**Decision:** DEFERRED',
      '**Reason:** Tracked in GH-301.',
      '',
      '## Issue: Unused import',
      '**Decision:** NOT_APPLICABLE',
      '**Reason:** Import is used in conditional block.',
    ].join('\n');

    const result = parseReplyDecisions(content);
    assert.equal(result.length, 3);
    assert.equal(result[0].title, 'SQL injection risk');
    assert.equal(result[0].decision, 'FIXED');
    assert.equal(result[1].title, 'Missing error handling');
    assert.equal(result[1].decision, 'DEFERRED');
    assert.equal(result[2].title, 'Unused import');
    assert.equal(result[2].decision, 'NOT_APPLICABLE');
  });
});

describe('parseReplyDecisions — missing fields', () => {
  it('sets empty reason when Reason field is missing', () => {
    const content = ['## Issue: Some issue', '**Decision:** FIXED'].join('\n');

    const result = parseReplyDecisions(content);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Some issue');
    assert.equal(result[0].decision, 'FIXED');
    assert.equal(result[0].reason, '');
  });

  it('sets UNKNOWN decision when Decision field is missing', () => {
    const content = ['## Issue: Orphaned issue', '**Reason:** Something happened.'].join('\n');

    const result = parseReplyDecisions(content);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Orphaned issue');
    assert.equal(result[0].decision, 'UNKNOWN');
    assert.equal(result[0].reason, 'Something happened.');
  });

  it('handles DEFERRED with empty reason (blank after Reason:)', () => {
    const content = [
      '## Issue: Deferred without justification',
      '**Decision:** DEFERRED',
      '**Reason:**',
    ].join('\n');

    const result = parseReplyDecisions(content);
    assert.equal(result.length, 1);
    assert.equal(result[0].decision, 'DEFERRED');
    assert.equal(result[0].reason, '');
  });
});

describe('parseReplyDecisions — exports', () => {
  it('exports parseReplyDecisions as a function', () => {
    assert.equal(typeof parseReplyDecisions, 'function');
  });
});

// ===========================================================================
// isCodeReviewResolved — Task 2 (R1)
// ===========================================================================
describe('isCodeReviewResolved — all issues addressed', () => {
  it('returns resolved:true when all CRITICAL issues have FIXED replies', () => {
    const report = [
      '## Code Review',
      '### 🔴 CRITICAL ISSUES',
      '**Memory leak in handler**',
      'Details about the memory leak.',
      '**Unvalidated input**',
      'Details about unvalidated input.',
      '### 🟢 NICE-TO-HAVE',
      'Some suggestion.',
    ].join('\n');

    const reply = [
      '## Issue: Memory leak in handler',
      '**Decision:** FIXED',
      '**Reason:** Refactored handler.',
      '',
      '## Issue: Unvalidated input',
      '**Decision:** FIXED',
      '**Reason:** Added validation.',
    ].join('\n');

    const result = isCodeReviewResolved(report, reply);
    assert.equal(result.resolved, true);
    assert.deepStrictEqual(result.unaddressed, []);
  });

  it('returns resolved:true when DEFERRED has a reason', () => {
    const report = [
      '### 🔴 CRITICAL ISSUES',
      '**Security vulnerability**',
      'Details.',
      '### 🟢 NICE-TO-HAVE',
    ].join('\n');

    const reply = [
      '## Issue: Security vulnerability',
      '**Decision:** DEFERRED',
      '**Reason:** Tracked in GH-500 for next sprint.',
    ].join('\n');

    const result = isCodeReviewResolved(report, reply);
    assert.equal(result.resolved, true);
    assert.deepStrictEqual(result.unaddressed, []);
  });

  it('returns resolved:true when NOT_APPLICABLE decision given', () => {
    const report = [
      '### 🟡 IMPORTANT ISSUES',
      '**Missing test coverage**',
      'Needs tests.',
      '### 🟢 NICE-TO-HAVE',
    ].join('\n');

    const reply = [
      '## Issue: Missing test coverage',
      '**Decision:** NOT_APPLICABLE',
      '**Reason:** Tests exist in separate integration suite.',
    ].join('\n');

    const result = isCodeReviewResolved(report, reply);
    assert.equal(result.resolved, true);
    assert.deepStrictEqual(result.unaddressed, []);
  });
});

describe('isCodeReviewResolved — unaddressed issues', () => {
  it('returns resolved:false when a CRITICAL issue has no reply', () => {
    const report = [
      '### 🔴 CRITICAL ISSUES',
      '**Memory leak in handler**',
      'Details.',
      '**Unvalidated input**',
      'Details.',
      '### 🟢 NICE-TO-HAVE',
    ].join('\n');

    const reply = [
      '## Issue: Memory leak in handler',
      '**Decision:** FIXED',
      '**Reason:** Fixed it.',
    ].join('\n');

    const result = isCodeReviewResolved(report, reply);
    assert.equal(result.resolved, false);
    assert.equal(result.unaddressed.length, 1);
    assert.ok(result.unaddressed[0].includes('Unvalidated input'));
  });

  it('returns resolved:false when DEFERRED has no reason', () => {
    const report = [
      '### 🔴 CRITICAL ISSUES',
      '**Security vulnerability**',
      'Details.',
      '### 🟢 NICE-TO-HAVE',
    ].join('\n');

    const reply = [
      '## Issue: Security vulnerability',
      '**Decision:** DEFERRED',
      '**Reason:**',
    ].join('\n');

    const result = isCodeReviewResolved(report, reply);
    assert.equal(result.resolved, false);
    assert.equal(result.unaddressed.length, 1);
    assert.ok(result.unaddressed[0].includes('Security vulnerability'));
  });

  it('returns resolved:false when IMPORTANT issue has no reply', () => {
    const report = [
      '### 🟡 IMPORTANT ISSUES',
      '**Error handling missing**',
      'Details.',
      '### 🟢 NICE-TO-HAVE',
    ].join('\n');

    const reply = ''; // empty reply

    const result = isCodeReviewResolved(report, reply);
    assert.equal(result.resolved, false);
    assert.equal(result.unaddressed.length, 1);
    assert.ok(result.unaddressed[0].includes('Error handling missing'));
  });
});

describe('isCodeReviewResolved — no blocking issues', () => {
  it('returns resolved:true when report has no CRITICAL or IMPORTANT issues', () => {
    const report = [
      '## Code Review',
      '### 🟢 NICE-TO-HAVE IMPROVEMENTS',
      '**Consider renaming variable**',
      'Minor style suggestion.',
    ].join('\n');

    const reply = ''; // no reply needed

    const result = isCodeReviewResolved(report, reply);
    assert.equal(result.resolved, true);
    assert.deepStrictEqual(result.unaddressed, []);
  });

  it('returns resolved:true when report has "No critical issues" text', () => {
    const report = ['## Code Review', 'Status: APPROVED', 'No critical issues found.'].join('\n');

    const result = isCodeReviewResolved(report, '');
    assert.equal(result.resolved, true);
    assert.deepStrictEqual(result.unaddressed, []);
  });
});

describe('isCodeReviewResolved — null safety', () => {
  it('returns resolved:false for null report (cannot verify empty content)', () => {
    const result = isCodeReviewResolved(null, null);
    assert.equal(result.resolved, false);
    assert.ok(result.unaddressed.length > 0, 'empty report should have unaddressed marker');
  });

  it('returns resolved:false for empty report (cannot verify empty content)', () => {
    const result = isCodeReviewResolved('', '');
    assert.equal(result.resolved, false);
    assert.ok(result.unaddressed.length > 0, 'empty report should have unaddressed marker');
  });
});

describe('isCodeReviewResolved — exports', () => {
  it('exports isCodeReviewResolved as a function', () => {
    assert.equal(typeof isCodeReviewResolved, 'function');
  });
});

describe('isCodeReviewResolved — inline CRITICAL/IMPORTANT heading format', () => {
  it('extracts issues from ### CRITICAL: Title format', () => {
    const report = [
      '# Code Review',
      '',
      '### CRITICAL: Memory leak in handler',
      'Details about the leak.',
      '',
      '### CRITICAL: SQL injection risk',
      'Details about the risk.',
    ].join('\n');

    const result = isCodeReviewResolved(report, '');
    assert.equal(result.resolved, false);
    assert.equal(result.unaddressed.length, 2);
    assert.ok(result.unaddressed.some((t) => t.includes('Memory leak in handler')));
    assert.ok(result.unaddressed.some((t) => t.includes('SQL injection risk')));
  });

  it('resolves inline CRITICAL heading issues via reply', () => {
    const report = ['### CRITICAL: Memory leak in handler', 'Details.'].join('\n');

    const reply = [
      '## Issue: Memory leak in handler',
      '**Decision:** FIXED',
      '**Reason:** Fixed the leak.',
    ].join('\n');

    const result = isCodeReviewResolved(report, reply);
    assert.equal(result.resolved, true);
  });
});

// ===========================================================================
// GH-232 Task 4: extractIssueTitles spurious title filtering
// ===========================================================================
describe('isCodeReviewResolved — spurious title filtering (GH-232)', () => {
  it('does not treat bold CRITICAL keyword in body as an issue title', () => {
    const report = [
      '### 🔴 CRITICAL ISSUES',
      '**CRITICAL** mention in body text should not be an issue.',
      '### 🟢 NICE-TO-HAVE',
    ].join('\n');

    const result = isCodeReviewResolved(report, '');
    // "CRITICAL" alone should be filtered out as a spurious title
    assert.equal(
      result.resolved,
      true,
      'CRITICAL keyword alone must not be treated as issue title'
    );
    assert.deepStrictEqual(result.unaddressed, []);
  });

  it('does not treat "**CRITICAL:**" (with trailing colon) as an issue title', () => {
    const report = [
      '### 🔴 CRITICAL ISSUES',
      '**CRITICAL:** this describes the section, not an issue.',
      '### 🟢 NICE-TO-HAVE',
    ].join('\n');

    const result = isCodeReviewResolved(report, '');
    assert.equal(result.resolved, true, 'CRITICAL: with colon must be filtered by SPURIOUS_TITLE_RE');
    assert.deepStrictEqual(result.unaddressed, []);
  });

  it('does not treat bold IMPORTANT keyword in body as an issue title', () => {
    const report = [
      '### 🟡 IMPORTANT ISSUES',
      '**IMPORTANT** this is emphasized text, not an issue title.',
      '### 🟢 NICE-TO-HAVE',
    ].join('\n');

    const result = isCodeReviewResolved(report, '');
    assert.equal(
      result.resolved,
      true,
      'IMPORTANT keyword alone must not be treated as issue title'
    );
    assert.deepStrictEqual(result.unaddressed, []);
  });

  it('does not treat bold field labels with colon like "**File:**" as issue titles', () => {
    const report = [
      '### 🔴 CRITICAL ISSUES',
      '**Memory leak in handler**',
      '**File:** src/handler.js',
      '**Description:** Resource not freed',
      '**Status:** open',
      '### 🟢 NICE-TO-HAVE',
    ].join('\n');

    const reply = [
      '## Issue: Memory leak in handler',
      '**Decision:** FIXED',
      '**Reason:** Fixed it.',
    ].join('\n');

    const result = isCodeReviewResolved(report, reply);
    assert.equal(result.resolved, true, 'Field labels with colon must not be issue titles');
  });

  it('does not treat "**Note:**" as an issue title', () => {
    const report = [
      '### 🔴 CRITICAL ISSUES',
      '**Unsafe input handling**',
      '**Note:** This affects all endpoints',
      '### 🟢 NICE-TO-HAVE',
    ].join('\n');

    const reply = [
      '## Issue: Unsafe input handling',
      '**Decision:** FIXED',
      '**Reason:** Added validation.',
    ].join('\n');

    const result = isCodeReviewResolved(report, reply);
    assert.equal(result.resolved, true, '"Note:" should be filtered as a field label');
  });

  it('treats "No error handling in foo()" as a real issue title (not filtered by SPURIOUS_TITLE_RE)', () => {
    const report = [
      '### 🔴 CRITICAL ISSUES',
      '**No error handling in foo()**',
      'Details.',
      '### 🟢 NICE-TO-HAVE',
    ].join('\n');

    const result = isCodeReviewResolved(report, '');
    assert.equal(result.resolved, false, '"No error handling in foo()" is a real issue');
    assert.ok(result.unaddressed[0].includes('No error handling'));
  });

  it('does not treat short bold words (<=2 chars) as issue titles', () => {
    const report = [
      '### 🔴 CRITICAL ISSUES',
      '**No** issues found here. **It** is confirmed.',
      '### 🟢 NICE-TO-HAVE',
    ].join('\n');

    const result = isCodeReviewResolved(report, '');
    assert.equal(result.resolved, true, 'Short bold words must not be treated as issue titles');
    assert.deepStrictEqual(result.unaddressed, []);
  });

  it('treats 3-char titles like XSS or SQL as real issue titles', () => {
    const report = [
      '### 🔴 CRITICAL ISSUES',
      '**XSS** vulnerability found in input handler.',
      '### 🟢 NICE-TO-HAVE',
    ].join('\n');

    const result = isCodeReviewResolved(report, '');
    assert.equal(result.resolved, false, '3-char titles like XSS should be treated as real issues');
    assert.equal(result.unaddressed.length, 1);
    assert.ok(result.unaddressed[0].includes('XSS'));
  });

  it('does not treat field labels like Decision/Status/Reason as issue titles', () => {
    const report = [
      '### 🔴 CRITICAL ISSUES',
      '**Decision** was made to defer. **Status** is pending. **Reason** is unclear.',
      '### 🟢 NICE-TO-HAVE',
    ].join('\n');

    const result = isCodeReviewResolved(report, '');
    assert.equal(result.resolved, true, 'Field labels must not be treated as issue titles');
    assert.deepStrictEqual(result.unaddressed, []);
  });

  it('does not treat NICE-TO-HAVE or SUGGESTIONS as issue titles', () => {
    const report = [
      '### 🔴 CRITICAL ISSUES',
      '**NICE-TO-HAVE** improvements listed below. **SUGGESTIONS** for improvement.',
      '### 🟢 NICE-TO-HAVE',
    ].join('\n');

    const result = isCodeReviewResolved(report, '');
    assert.equal(result.resolved, true, 'Category keywords must not be treated as issue titles');
    assert.deepStrictEqual(result.unaddressed, []);
  });

  it('still extracts real issue titles that are descriptive', () => {
    const report = [
      '### 🔴 CRITICAL ISSUES',
      '**Memory leak in event handler**',
      'Details about the leak.',
      '### 🟢 NICE-TO-HAVE',
    ].join('\n');

    const reply = [
      '## Issue: Memory leak in event handler',
      '**Decision:** FIXED',
      '**Reason:** Fixed the leak.',
    ].join('\n');

    const result = isCodeReviewResolved(report, reply);
    assert.equal(result.resolved, true);
    assert.deepStrictEqual(result.unaddressed, []);
  });

  it('still flags real issues as unaddressed even with spurious titles filtered', () => {
    const report = [
      '### 🔴 CRITICAL ISSUES',
      '**CRITICAL** emphasis in text.',
      '**SQL injection vulnerability**',
      'Details about the vulnerability.',
      '### 🟢 NICE-TO-HAVE',
    ].join('\n');

    const result = isCodeReviewResolved(report, '');
    assert.equal(result.resolved, false);
    assert.equal(result.unaddressed.length, 1);
    assert.ok(result.unaddressed[0].includes('SQL injection vulnerability'));
  });
});

// isCodeReviewResolved — write-code-review.js "Issues Found" format
describe('isCodeReviewResolved — Issues Found list format (write-code-review.js)', () => {
  it('extracts critical issues from **[🔴 Critical] title** format', () => {
    const report = [
      '## Issues Found',
      '',
      '**[🔴 Critical] SQL injection in user input**',
      '- File: `src/api.js:42`',
      '- Description: User input not sanitized',
      '',
      '**[🟡 Important] Missing error handling**',
      '- File: `src/handler.js:10`',
      '- Description: No try-catch around async call',
    ].join('\n');

    const result = isCodeReviewResolved(report, '');
    assert.equal(result.resolved, false);
    assert.equal(result.blockingCount, 2);
    assert.ok(result.unaddressed.some((t) => t.includes('SQL injection')));
    assert.ok(result.unaddressed.some((t) => t.includes('Missing error handling')));
  });

  it('resolves Issues Found format when reply addresses all issues', () => {
    const report = [
      '## Issues Found',
      '',
      '**[🔴 Critical] SQL injection in user input**',
      '- Description: User input not sanitized',
    ].join('\n');

    const reply = [
      '## Issue: SQL injection in user input',
      '**Decision:** FIXED',
      '**Reason:** Added parameterized queries',
    ].join('\n');

    const result = isCodeReviewResolved(report, reply);
    assert.equal(result.resolved, true);
    assert.equal(result.blockingCount, 1);
    assert.equal(result.unaddressed.length, 0);
  });

  it('marks Issues Found format unresolved when reply is missing', () => {
    const report = [
      '## Issues Found',
      '',
      '**[🔴 Critical] XSS vulnerability**',
      '- Description: Unescaped HTML output',
      '',
      '**[🟡 Important] Hardcoded credentials**',
      '- Description: API key in source',
    ].join('\n');

    const reply = [
      '## Issue: XSS vulnerability',
      '**Decision:** FIXED',
      '**Reason:** Added HTML escaping',
    ].join('\n');

    const result = isCodeReviewResolved(report, reply);
    assert.equal(result.resolved, false);
    assert.equal(result.blockingCount, 2);
    assert.equal(result.unaddressed.length, 1);
    assert.ok(result.unaddressed[0].includes('Hardcoded credentials'));
  });

  it('ignores nice-to-have issues in Issues Found format', () => {
    const report = [
      '## Issues Found',
      '',
      '**[🔵 Nice-to-have] Consider adding docs**',
      '- Description: Function lacks JSDoc',
    ].join('\n');

    const result = isCodeReviewResolved(report, '');
    assert.equal(result.resolved, true);
    assert.equal(result.blockingCount, 0);
  });
});
