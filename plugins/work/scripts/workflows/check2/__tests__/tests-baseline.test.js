/**
 * Tests for check2/lib/tests-baseline.js (GH-394, echo-5137-4 partial):
 * cached tests-baseline.json read/write and the net-new vs pre-existing split.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  BASELINE_FILE,
  readBaseline,
  writeBaseline,
  splitFailures,
} = require('../lib/tests-baseline');

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-baseline-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CHECK_TESTS_BASELINE;
});

describe('readBaseline', () => {
  it('returns null when the file is missing (baseline unavailable)', () => {
    assert.equal(readBaseline(dir), null);
  });

  it('returns null on unparseable content', () => {
    fs.writeFileSync(path.join(dir, BASELINE_FILE), 'not json');
    assert.equal(readBaseline(dir), null);
  });

  it('returns null when failures is not an array', () => {
    fs.writeFileSync(path.join(dir, BASELINE_FILE), JSON.stringify({ failures: 'nope' }));
    assert.equal(readBaseline(dir), null);
  });

  it('reads a valid baseline and filters non-string/empty entries', () => {
    fs.writeFileSync(
      path.join(dir, BASELINE_FILE),
      JSON.stringify({ ref: 'abc123', recordedAt: '2026-01-01', failures: ['a > b', '', 42, '  '] })
    );
    const b = readBaseline(dir);
    assert.equal(b.ref, 'abc123');
    assert.deepEqual(b.failures, ['a > b']);
  });

  it('is disabled by CHECK_TESTS_BASELINE=0', () => {
    fs.writeFileSync(path.join(dir, BASELINE_FILE), JSON.stringify({ failures: [] }));
    process.env.CHECK_TESTS_BASELINE = '0';
    assert.equal(readBaseline(dir), null);
  });
});

describe('writeBaseline', () => {
  it('writes a readable green baseline', () => {
    writeBaseline(dir, []);
    const b = readBaseline(dir);
    assert.ok(b);
    assert.deepEqual(b.failures, []);
    assert.notEqual(b.recordedAt, 'unknown');
  });

  it('is a no-op when CHECK_TESTS_BASELINE=0', () => {
    process.env.CHECK_TESTS_BASELINE = '0';
    writeBaseline(dir, []);
    assert.equal(fs.existsSync(path.join(dir, BASELINE_FILE)), false);
  });
});

describe('splitFailures', () => {
  it('everything is net-new without a baseline', () => {
    const { netNew, preExisting } = splitFailures(['a', 'b'], null);
    assert.deepEqual(netNew, ['a', 'b']);
    assert.deepEqual(preExisting, []);
  });

  it('splits exact matches into pre-existing', () => {
    const baseline = { failures: ['src/a.test.ts > a > one'] };
    const { netNew, preExisting } = splitFailures(
      ['src/a.test.ts > a > one', 'src/b.test.ts > b > two'],
      baseline
    );
    assert.deepEqual(preExisting, ['src/a.test.ts > a > one']);
    assert.deepEqual(netNew, ['src/b.test.ts > b > two']);
  });

  it('matches loosely across identifier formats (containment either way)', () => {
    const baseline = { failures: ['loads default seed data'] };
    const { netNew, preExisting } = splitFailures(
      [
        'scripts/setup-test-db-lib.integration.test.ts > setupTestDatabase > loads default seed data',
      ],
      baseline
    );
    assert.equal(preExisting.length, 1);
    assert.equal(netNew.length, 0);
  });

  it('green baseline (failures: []) → all current failures are net-new', () => {
    const baseline = { failures: [] };
    const { netNew, preExisting } = splitFailures(['a'], baseline);
    assert.deepEqual(netNew, ['a']);
    assert.deepEqual(preExisting, []);
  });
});
