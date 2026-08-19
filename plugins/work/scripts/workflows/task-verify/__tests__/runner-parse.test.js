'use strict';

/**
 * Reporter-parsing unit tests (GH-755 review follow-up): JSON blobs must be
 * found even when the runner prints warnings (possibly containing `{`)
 * before the document, and the dead built-in-module dependency check is
 * gone from runner detection.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseJsonReporter, parseNodeTestSummary, scrubTestFlags } = require('../collect/runner');

describe('task-verify runner parsers (GH-755)', () => {
  it('parses a clean jest/vitest JSON document', () => {
    const out = JSON.stringify({ numTotalTests: 7, numFailedTests: 2 });
    assert.deepEqual(parseJsonReporter(out), { testsRan: 7, failures: 2 });
  });

  it('parses when a warning containing { precedes the JSON blob', () => {
    const out = [
      'Warning: config option {foo} is deprecated',
      'another line',
      JSON.stringify({ numTotalTests: 3, numFailedTests: 0 }),
    ].join('\n');
    assert.deepEqual(parseJsonReporter(out), { testsRan: 3, failures: 0 });
  });

  it('returns null for output with no reporter document', () => {
    assert.equal(parseJsonReporter('all good, no json here'), null);
    assert.equal(parseJsonReporter('{"unrelated": true}'), null);
  });

  describe('playwright --reporter=json', () => {
    // Playwright has no numTotalTests; counts live under `stats`. Without a
    // parser for that shape a green e2e suite degrades to exit-code-only and
    // the verdict engine reports I4 "tests do not pass on head (no structured
    // reporter output)" for every e2e-lane task.
    const pw = (stats) => JSON.stringify({ suites: [], errors: [], stats }, null, 2);

    it('parses a passing run', () => {
      const out = pw({
        startTime: '2026-01-01T00:00:00.000Z',
        duration: 24509,
        expected: 7,
        skipped: 0,
        unexpected: 0,
        flaky: 0,
      });
      assert.deepEqual(parseJsonReporter(out), { testsRan: 7, failures: 0 });
    });

    it('parses a failing run', () => {
      const out = pw({ expected: 5, skipped: 0, unexpected: 2, flaky: 0 });
      assert.deepEqual(parseJsonReporter(out), { testsRan: 7, failures: 2 });
    });

    it('counts flaky tests as run but not as failures', () => {
      // A flaky test passed on retry, so it must not fail the boundary.
      const out = pw({ expected: 5, skipped: 1, unexpected: 0, flaky: 2 });
      assert.deepEqual(parseJsonReporter(out), { testsRan: 7, failures: 0 });
    });

    it('survives trailing stderr appended after the pretty-printed document', () => {
      // interpretRun concatenates stdout + stderr, so slicing the first `{` to
      // end-of-string trails non-JSON; the document is multi-line so the
      // per-line scan cannot recover it either.
      const out = `${pw({ expected: 7, skipped: 0, unexpected: 0, flaky: 0 })}\nwarn: teardown noise\n`;
      assert.deepEqual(parseJsonReporter(out), { testsRan: 7, failures: 0 });
    });

    it('ignores a stats object that is not playwright-shaped', () => {
      assert.equal(parseJsonReporter(JSON.stringify({ stats: { total: 3 } })), null);
    });
  });

  it('parses node --test TAP and spec summaries', () => {
    assert.deepEqual(parseNodeTestSummary('# tests 4\n# fail 1\n'), { testsRan: 4, failures: 1 });
    assert.deepEqual(parseNodeTestSummary('ℹ tests 2\nℹ fail 0\n'), { testsRan: 2, failures: 0 });
    assert.equal(parseNodeTestSummary('no summary'), null);
  });

  it('scrubTestFlags drops only the --test* family from NODE_OPTIONS', () => {
    assert.equal(
      scrubTestFlags('--max-old-space-size=4096 --test-reporter=tap --require ./setup.js'),
      '--max-old-space-size=4096 --require ./setup.js'
    );
    assert.equal(
      scrubTestFlags('--test-reporter tap --test-reporter-destination stdout --import tsx'),
      '--import tsx'
    );
    assert.equal(scrubTestFlags('--experimental-test-coverage'), '');
    assert.equal(scrubTestFlags('--test-only --enable-source-maps'), '--enable-source-maps');
    assert.equal(scrubTestFlags(undefined), '');
    assert.equal(scrubTestFlags(''), '');
  });
});
