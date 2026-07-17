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
