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

  it('recognizes Status: NEEDS_WORK', () => {
    const result = parseReportStatus('Status: NEEDS_WORK', 'codeReview');
    assert.deepStrictEqual(result, { status: 'NEEDS_WORK', icon: '⚠️' });
  });

  it('recognizes Status: NOT_APPLICABLE', () => {
    const result = parseReportStatus('Status: NOT_APPLICABLE', 'qa');
    assert.deepStrictEqual(result, { status: 'NOT_APPLICABLE', icon: '➖' });
  });

  it('recognizes Status: FAIL as NEEDS_WORK', () => {
    const result = parseReportStatus('Status: FAIL', 'tests');
    assert.deepStrictEqual(result, { status: 'NEEDS_WORK', icon: '⚠️' });
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
    const content = [
      '| Field | Value |',
      '|-------|-------|',
      '| Status | APPROVED |',
    ].join('\n');
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
    assert.deepStrictEqual(result, { status: 'NEEDS_WORK', icon: '⚠️' });
  });
});

// ---------------------------------------------------------------------------
// R10: Fail-first precedence
// ---------------------------------------------------------------------------
describe('parseReportStatus — fail-first precedence (R10)', () => {
  it('returns NEEDS_WORK when CRITICAL present alongside APPROVED', () => {
    const content = [
      'Status: APPROVED',
      '',
      '## Issues',
      '### CRITICAL: Memory leak in handler',
    ].join('\n');
    const result = parseReportStatus(content, 'codeReview');
    assert.deepStrictEqual(result, { status: 'NEEDS_WORK', icon: '⚠️' });
  });

  it('returns NEEDS_WORK when fail pattern present with pass pattern for tests', () => {
    const content = [
      '✅ PASS: 10 tests',
      '❌ FAIL: 2 tests',
    ].join('\n');
    const result = parseReportStatus(content, 'tests');
    assert.deepStrictEqual(result, { status: 'NEEDS_WORK', icon: '⚠️' });
  });

  it('returns NEEDS_WORK for code review with NEEDS_WORK status and APPROVED in body', () => {
    const content = [
      'Status: NEEDS_WORK',
      '',
      'Previously APPROVED items remain valid.',
    ].join('\n');
    const result = parseReportStatus(content, 'codeReview');
    assert.deepStrictEqual(result, { status: 'NEEDS_WORK', icon: '⚠️' });
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

  it('recognizes "No critical" for codeReview type', () => {
    const result = parseReportStatus('No critical issues found', 'codeReview');
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

  it('still returns NEEDS_WORK when CRITICAL appears in issue body (not header)', () => {
    const content = 'Status: APPROVED\n\n## Issues\n### CRITICAL: Memory leak in handler';
    const result = parseReportStatus(content, 'codeReview');
    assert.deepStrictEqual(result, { status: 'NEEDS_WORK', icon: '⚠️' });
  });

  it('still returns NEEDS_WORK for bare CRITICAL word in prose', () => {
    const content = 'Status: APPROVED\n\nFound a CRITICAL bug in the parser.';
    const result = parseReportStatus(content, 'codeReview');
    assert.deepStrictEqual(result, { status: 'NEEDS_WORK', icon: '⚠️' });
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

  it('content with CRITICAL and APPROVED returns NEEDS_WORK for codeReview', () => {
    const content =
      'Status: APPROVED\n\n## Issues\n### CRITICAL: Unhandled error\nSome detail here.';
    const result = parseReportStatus(content, 'codeReview');
    assert.equal(result.status, 'NEEDS_WORK');
    assert.equal(result.icon, '⚠️');
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
    const content = [
      '## Issue: Some issue',
      '**Decision:** FIXED',
    ].join('\n');

    const result = parseReplyDecisions(content);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Some issue');
    assert.equal(result[0].decision, 'FIXED');
    assert.equal(result[0].reason, '');
  });

  it('sets UNKNOWN decision when Decision field is missing', () => {
    const content = [
      '## Issue: Orphaned issue',
      '**Reason:** Something happened.',
    ].join('\n');

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
    const report = [
      '## Code Review',
      'Status: APPROVED',
      'No critical issues found.',
    ].join('\n');

    const result = isCodeReviewResolved(report, '');
    assert.equal(result.resolved, true);
    assert.deepStrictEqual(result.unaddressed, []);
  });
});

describe('isCodeReviewResolved — null safety', () => {
  it('returns resolved:true for null report', () => {
    const result = isCodeReviewResolved(null, null);
    assert.equal(result.resolved, true);
    assert.deepStrictEqual(result.unaddressed, []);
  });

  it('returns resolved:true for empty report', () => {
    const result = isCodeReviewResolved('', '');
    assert.equal(result.resolved, true);
    assert.deepStrictEqual(result.unaddressed, []);
  });
});

describe('isCodeReviewResolved — exports', () => {
  it('exports isCodeReviewResolved as a function', () => {
    assert.equal(typeof isCodeReviewResolved, 'function');
  });
});
