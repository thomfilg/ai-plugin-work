'use strict';

// infra-patterns.test.js — tests for plugins/work/scripts/workflows/follow-up/lib/infra-patterns.js
//
// Covers GH-536 Task 1 (RED phase). Asserts the module's pure exports:
//   - INFRA_FAILURE_PATTERNS (RegExp[]) — matches each of the 6+ required tokens
//   - STALE_THRESHOLD_SECONDS === 60 (single source of truth for staleness threshold)
//   - isInfraFailure(output) — positive matches for each pattern, false for non-infra failures
//   - isStale(lastMonitorAt, now?) — null/undefined treated as infinitely old (R8 legacy compat)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const infraPatterns = require('../infra-patterns');

describe('infra-patterns module exports', () => {
  it('exports INFRA_FAILURE_PATTERNS as a non-empty array of RegExp', () => {
    assert.ok(Array.isArray(infraPatterns.INFRA_FAILURE_PATTERNS));
    assert.ok(infraPatterns.INFRA_FAILURE_PATTERNS.length > 0);
    for (const p of infraPatterns.INFRA_FAILURE_PATTERNS) {
      assert.ok(p instanceof RegExp, `expected RegExp, got ${typeof p}`);
    }
  });

  it('STALE_THRESHOLD_SECONDS === 60 (single named constant per R6)', () => {
    assert.equal(infraPatterns.STALE_THRESHOLD_SECONDS, 60);
  });

  it('exports isInfraFailure and isStale as functions', () => {
    assert.equal(typeof infraPatterns.isInfraFailure, 'function');
    assert.equal(typeof infraPatterns.isStale, 'function');
  });
});

describe('isInfraFailure — positive cases (each required pattern from brief P0 #2)', () => {
  const requiredTokens = [
    'Could not resolve to a Repository with the name "octocat/Hello-World".',
    'HTTP 401: Unauthorized',
    'HTTP 403: Forbidden',
    'HTTP 404: Not Found',
    'gh command failed: exit status 1',
    'getaddrinfo ENOTFOUND api.github.com',
    'connect ETIMEDOUT 140.82.121.4:443',
    'read ECONNRESET',
  ];

  for (const token of requiredTokens) {
    it(`matches ${JSON.stringify(token)}`, () => {
      assert.equal(infraPatterns.isInfraFailure(token), true);
    });
  }
});

describe('isInfraFailure — negative cases', () => {
  it('returns false for non-infra failure ("Reviews: 2 BLOCKING")', () => {
    assert.equal(infraPatterns.isInfraFailure('Reviews: 2 BLOCKING'), false);
  });

  it('returns false for null', () => {
    assert.equal(infraPatterns.isInfraFailure(null), false);
  });

  it('returns false for undefined', () => {
    assert.equal(infraPatterns.isInfraFailure(undefined), false);
  });

  it('returns false for empty string', () => {
    assert.equal(infraPatterns.isInfraFailure(''), false);
  });

  it('returns false for unrelated CI failure text', () => {
    assert.equal(
      infraPatterns.isInfraFailure('CI: FAILING — test suite returned 3 failures'),
      false
    );
  });

  // Negative cases for the line-anchored HTTP / gh-CLI patterns. These guard
  // against false positives where a test log or stack frame happens to print
  // the same tokens mid-line — auto-clearing real CI failures would silently
  // swallow them.
  it('returns false for mid-line "HTTP 401" inside a test assertion', () => {
    assert.equal(
      infraPatterns.isInfraFailure('FAIL api.test.ts > returns HTTP 401 when token invalid'),
      false
    );
  });

  it('returns false for mid-line "HTTP 404" inside an expectation message', () => {
    assert.equal(
      infraPatterns.isInfraFailure('expected response.status to be 200, got HTTP 404'),
      false
    );
  });

  it('returns false for mid-line "gh command failed" inside a stack frame', () => {
    assert.equal(
      infraPatterns.isInfraFailure('stack trace: at gh command failed handler in user code'),
      false
    );
  });

  // Positive cases for the line-anchored variants — both `^` and `\n` anchors
  // must keep matching real gh-CLI surface output.
  it('returns true for a leading "HTTP 401" at line start (no indent)', () => {
    assert.equal(infraPatterns.isInfraFailure('HTTP 401: Bad credentials'), true);
  });

  it('returns true for "HTTP 403" preceded by a newline in multi-line output', () => {
    assert.equal(
      infraPatterns.isInfraFailure('gh: error fetching reviews\n  HTTP 403: Forbidden'),
      true
    );
  });

  it('returns true for "gh command failed" at line start of multi-line output', () => {
    assert.equal(
      infraPatterns.isInfraFailure('some preamble\ngh command failed: exit status 1'),
      true
    );
  });
});

describe('isStale — legacy compat (R8: missing timestamp is infinitely old)', () => {
  it('returns true when lastMonitorAt is null', () => {
    assert.equal(infraPatterns.isStale(null), true);
  });

  it('returns true when lastMonitorAt is undefined', () => {
    assert.equal(infraPatterns.isStale(undefined), true);
  });
});

describe('isStale — threshold behavior (default 60s)', () => {
  it('returns false for a fresh timestamp (30s ago)', () => {
    const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString();
    assert.equal(infraPatterns.isStale(thirtySecondsAgo), false);
  });

  it('returns true for a stale timestamp (120s ago)', () => {
    const twoMinutesAgo = new Date(Date.now() - 120_000).toISOString();
    assert.equal(infraPatterns.isStale(twoMinutesAgo), true);
  });

  it('honors explicit `now` argument', () => {
    const t0 = Date.parse('2026-01-01T00:00:00.000Z');
    const lastMonitorAt = new Date(t0).toISOString();
    // 59s later -> fresh
    assert.equal(infraPatterns.isStale(lastMonitorAt, t0 + 59_000), false);
    // 60s later -> stale (>= threshold)
    assert.equal(infraPatterns.isStale(lastMonitorAt, t0 + 60_000), true);
    // 61s later -> stale
    assert.equal(infraPatterns.isStale(lastMonitorAt, t0 + 61_000), true);
  });
});
