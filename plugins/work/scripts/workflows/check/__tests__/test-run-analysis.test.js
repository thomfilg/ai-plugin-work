/**
 * Tests for check/lib/test-run-analysis.js (GH-394).
 *
 * Fixtures are real-ish runner outputs:
 * - vitest full-suite OOM (echo-4491-003): all tests pass, worker fork OOMs,
 *   exit 1 → must classify CRASHED with the signature quoted, never FAILED.
 * - vitest single 30s-timeout flake (echo-4492-001): FAILED + transient
 *   signature + failing test extracted → retry-eligible.
 * - "0 tests executed with nonzero exit" (M === 0 guard) → CRASHED.
 * - node --test TAP outputs.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectCrashSignature,
  detectTransientSignature,
  parseTestCounts,
  extractFailingTests,
  classifyRun,
  shouldRetry,
} = require('../lib/test-run-analysis');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VITEST_OOM_ALL_PASS = [
  ' ✓ src/api/users.test.ts (412)',
  ' ✓ src/api/workbooks.test.ts (7838)',
  '',
  ' Test Files  275 passed (275)',
  '      Tests  8250 passed | 3 skipped (8253)',
  '',
  '<--- Last few GCs --->',
  '[41231:0x6a8e0d0]  1203845 ms: Mark-Compact 4044.7 (4130.9) -> 4028.9 (4131.4) MB',
  '',
  'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory',
  ' 1: 0xb85bc0 node::Abort() [node]',
].join('\n');

const VITEST_TIMEOUT_FLAKE = [
  ' FAIL  scripts/setup-test-db-lib.integration.test.ts > setupTestDatabase > loads default seed data that includes label categories and label values',
  'Error: Test timed out in 30000ms.',
  '',
  ' Test Files  1 failed | 274 passed (275)',
  '      Tests  1 failed | 3485 passed | 2 skipped (3488)',
].join('\n');

const VITEST_MANY_FAILURES = [
  ' FAIL  src/a.test.ts > a > one',
  ' FAIL  src/a.test.ts > a > two',
  ' FAIL  src/b.test.ts > b > three',
  ' FAIL  src/b.test.ts > b > four',
  ' FAIL  src/b.test.ts > b > five',
  ' FAIL  src/c.test.ts > c > six',
  ' FAIL  src/c.test.ts > c > seven',
  '',
  ' Tests  7 failed | 100 passed (107)',
  'AssertionError: expected 1 to equal 2',
].join('\n');

const NODE_TEST_FAIL = [
  '✔ passes fine (1.2ms)',
  '✖ fails hard (3.4ms)',
  'not ok 2 - fails hard',
  '# tests 2',
  '# pass 1',
  '# fail 1',
].join('\n');

const NODE_TEST_ZERO_EXECUTED = ['# tests 0', '# pass 0', '# fail 0', '# skipped 0'].join('\n');

const WORKER_CRASH = [
  ' RUN  v1.6.0',
  'Error: Worker exited unexpectedly',
  '    at ChildProcess.<anonymous>',
].join('\n');

const SIGSEGV_CRASH = 'Test run terminated with signal SIGSEGV\n';

const ECONNREFUSED_FAIL = [
  ' FAIL  src/db.integration.test.ts > db > connects',
  'Error: connect ECONNREFUSED 127.0.0.1:5432',
  ' Tests  1 failed | 12 passed (13)',
].join('\n');

// ---------------------------------------------------------------------------
// detectCrashSignature
// ---------------------------------------------------------------------------

describe('detectCrashSignature', () => {
  it('quotes the exact OOM line', () => {
    const sig = detectCrashSignature(VITEST_OOM_ALL_PASS);
    assert.ok(sig.includes('JavaScript heap out of memory'), sig);
  });

  it('detects worker crash', () => {
    assert.ok(detectCrashSignature(WORKER_CRASH).includes('Worker exited unexpectedly'));
  });

  it('detects signal termination', () => {
    assert.ok(detectCrashSignature(SIGSEGV_CRASH).includes('SIGSEGV'));
  });

  it('returns null for plain assertion failures', () => {
    assert.equal(detectCrashSignature(VITEST_TIMEOUT_FLAKE), null);
    assert.equal(detectCrashSignature(NODE_TEST_FAIL), null);
  });
});

// ---------------------------------------------------------------------------
// detectTransientSignature
// ---------------------------------------------------------------------------

describe('detectTransientSignature', () => {
  it('detects vitest 30s timeout', () => {
    assert.ok(detectTransientSignature(VITEST_TIMEOUT_FLAKE).includes('timed out'));
  });

  it('detects ECONNREFUSED', () => {
    assert.ok(detectTransientSignature(ECONNREFUSED_FAIL).includes('ECONNREFUSED'));
  });

  it('detects port in use', () => {
    assert.ok(detectTransientSignature('Error: listen EADDRINUSE: address already in use :::3000'));
  });

  it('returns null for plain assertion failures', () => {
    assert.equal(detectTransientSignature('AssertionError: expected 1 to equal 2'), null);
  });
});

// ---------------------------------------------------------------------------
// parseTestCounts
// ---------------------------------------------------------------------------

describe('parseTestCounts', () => {
  it('parses vitest summary (number-before-word), preferring the final Tests line', () => {
    const c = parseTestCounts(VITEST_TIMEOUT_FLAKE);
    assert.equal(c.failed, 1);
    assert.equal(c.passed, 3485);
    assert.equal(c.total, 3488);
  });

  it('parses vitest all-pass summary with skipped', () => {
    const c = parseTestCounts(VITEST_OOM_ALL_PASS);
    assert.equal(c.failed, null); // no "N failed" token at all
    assert.equal(c.passed, 8250);
    assert.equal(c.total, 8253);
  });

  it('parses node --test TAP counters (word-before-number)', () => {
    const c = parseTestCounts(NODE_TEST_FAIL);
    assert.equal(c.passed, 1);
    assert.equal(c.failed, 1);
    assert.equal(c.total, 2);
  });

  it('parses zero-executed TAP output', () => {
    const c = parseTestCounts(NODE_TEST_ZERO_EXECUTED);
    assert.equal(c.passed, 0);
    assert.equal(c.failed, 0);
    assert.equal(c.total, 0);
  });

  it('returns nulls on unparseable output', () => {
    const c = parseTestCounts("Error: Cannot find module 'vitest'");
    assert.equal(c.passed, null);
    assert.equal(c.failed, null);
    assert.equal(c.total, null);
  });
});

// ---------------------------------------------------------------------------
// extractFailingTests
// ---------------------------------------------------------------------------

describe('extractFailingTests', () => {
  it('extracts vitest FAIL lines with full path > suite > name', () => {
    const failing = extractFailingTests(VITEST_TIMEOUT_FLAKE);
    assert.equal(failing.length, 1);
    assert.ok(failing[0].startsWith('scripts/setup-test-db-lib.integration.test.ts >'));
  });

  it('extracts and dedupes node --test failures (✖ + not ok)', () => {
    const failing = extractFailingTests(NODE_TEST_FAIL);
    assert.deepEqual(failing, ['fails hard']);
  });

  it('returns [] when nothing recognizable', () => {
    assert.deepEqual(extractFailingTests('some random output'), []);
  });
});

// ---------------------------------------------------------------------------
// classifyRun — the crash-vs-fail core (echo-4491-003)
// ---------------------------------------------------------------------------

describe('classifyRun', () => {
  it('exit 0 → PASSED', () => {
    const a = classifyRun({ output: ' Tests  100 passed (100)', exitCode: 0 });
    assert.equal(a.result, 'PASSED');
  });

  it('all-pass + OOM + exit 1 → CRASHED with signature, never FAILED', () => {
    const a = classifyRun({ output: VITEST_OOM_ALL_PASS, exitCode: 1 });
    assert.equal(a.result, 'CRASHED');
    assert.ok(a.crashSignature.includes('JavaScript heap out of memory'));
  });

  it('M === 0 guard: 0 tests executed + nonzero exit → CRASHED, never pass or "all failed"', () => {
    const a = classifyRun({ output: NODE_TEST_ZERO_EXECUTED, exitCode: 1 });
    assert.equal(a.result, 'CRASHED');
    assert.ok(a.crashSignature.includes('0 tests executed'));
  });

  it('worker crash mid-run → CRASHED', () => {
    const a = classifyRun({ output: WORKER_CRASH, exitCode: 1 });
    assert.equal(a.result, 'CRASHED');
  });

  it('real assertion failure → FAILED with failing tests listed', () => {
    const a = classifyRun({ output: VITEST_TIMEOUT_FLAKE, exitCode: 1 });
    assert.equal(a.result, 'FAILED');
    assert.equal(a.failingTests.length, 1);
    assert.ok(a.transientSignature); // timeout
  });

  it('unparseable output + nonzero exit → FAILED (conservative, same as today)', () => {
    const a = classifyRun({ output: "Error: Cannot find module 'vitest'", exitCode: 1 });
    assert.equal(a.result, 'FAILED');
  });
});

// ---------------------------------------------------------------------------
// shouldRetry — flake-aware retry policy (echo-4492-001)
// ---------------------------------------------------------------------------

describe('shouldRetry', () => {
  it('small failing set (1 ≤ 5) → retry', () => {
    const a = classifyRun({ output: VITEST_TIMEOUT_FLAKE, exitCode: 1 });
    const { retry } = shouldRetry(a, { enabled: true, maxFailing: 5 });
    assert.equal(retry, true);
  });

  it('large failing set without transient signature → no retry', () => {
    const a = classifyRun({ output: VITEST_MANY_FAILURES, exitCode: 1 });
    assert.equal(a.result, 'FAILED');
    const { retry } = shouldRetry(a, { enabled: true, maxFailing: 5 });
    assert.equal(retry, false);
  });

  it('large failing set WITH transient signature → retry', () => {
    const output = VITEST_MANY_FAILURES + '\nError: connect ECONNREFUSED 127.0.0.1:5432';
    const a = classifyRun({ output, exitCode: 1 });
    const { retry, reason } = shouldRetry(a, { enabled: true, maxFailing: 5 });
    assert.equal(retry, true);
    assert.ok(reason.includes('transient'));
  });

  it('CRASHED runs are NEVER retried', () => {
    const a = classifyRun({ output: VITEST_OOM_ALL_PASS, exitCode: 1 });
    assert.equal(a.result, 'CRASHED');
    const { retry } = shouldRetry(a, { enabled: true, maxFailing: 5 });
    assert.equal(retry, false);
  });

  it('disabled (CHECK_FLAKE_RETRY=0 semantics) → no retry', () => {
    const a = classifyRun({ output: VITEST_TIMEOUT_FLAKE, exitCode: 1 });
    const { retry } = shouldRetry(a, { enabled: false });
    assert.equal(retry, false);
  });
});
