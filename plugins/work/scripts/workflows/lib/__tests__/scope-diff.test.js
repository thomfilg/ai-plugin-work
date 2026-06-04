/**
 * Tests for lib/scope-diff.js (Gate E).
 *
 * Run: node --test scripts/workflows/lib/__tests__/scope-diff.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { compareDiffToScope, summarizeScopeDiff } = require('../scope-diff');

describe('compareDiffToScope', () => {
  it('classifies each file into one of three buckets', () => {
    const tasks = [
      { filesInScope: ['lib/**'], filesOutOfScope: ['app/api/routers/**'] },
      { filesInScope: ['tests/**/*.test.js'], filesOutOfScope: [] },
    ];
    const diff = [
      'lib/foo.ts',
      'lib/sub/bar.ts',
      'tests/x/y.test.js',
      'app/api/routers/views.ts',
      'scripts/random.sh',
    ];
    const r = compareDiffToScope(diff, tasks);
    assert.deepEqual(r.inScope.sort(), ['lib/foo.ts', 'lib/sub/bar.ts', 'tests/x/y.test.js']);
    assert.deepEqual(r.outOfScope, ['app/api/routers/views.ts']);
    assert.deepEqual(r.unaccounted, ['scripts/random.sh']);
    assert.deepEqual(r.totals, { inScope: 3, outOfScope: 1, unaccounted: 1, total: 5 });
  });

  it('out-of-scope wins over in-scope (precedence)', () => {
    const tasks = [{ filesInScope: ['lib/**'], filesOutOfScope: ['lib/validation/**'] }];
    const r = compareDiffToScope(['lib/validation/zod.ts'], tasks);
    assert.deepEqual(r.outOfScope, ['lib/validation/zod.ts']);
    assert.deepEqual(r.inScope, []);
  });

  it('uses legacy suggestedScope when filesInScope is missing', () => {
    const tasks = [
      {
        suggestedScope: '- lib/legacy.ts\n- app/x.ts',
        filesOutOfScope: [],
      },
    ];
    const r = compareDiffToScope(['lib/legacy.ts', 'unrelated.ts'], tasks);
    assert.deepEqual(r.inScope, ['lib/legacy.ts']);
    assert.deepEqual(r.unaccounted, ['unrelated.ts']);
  });

  it('returns empty result for empty inputs', () => {
    const r = compareDiffToScope([], []);
    assert.deepEqual(r.totals, { inScope: 0, outOfScope: 0, unaccounted: 0, total: 0 });
  });

  it('handles non-array inputs gracefully', () => {
    assert.equal(compareDiffToScope(null, []).totals.total, 0);
    assert.equal(compareDiffToScope([], null).totals.total, 0);
  });

  it('normalizes backslash paths to forward slashes', () => {
    const tasks = [{ filesInScope: ['lib/foo.ts'] }];
    const r = compareDiffToScope(['lib\\foo.ts'], tasks);
    assert.deepEqual(r.inScope, ['lib/foo.ts']);
  });

  it('skips non-string entries in the diff', () => {
    const tasks = [{ filesInScope: ['lib/**'] }];
    const r = compareDiffToScope(['lib/x.ts', null, '', 42, 'lib/y.ts'], tasks);
    assert.deepEqual(r.inScope.sort(), ['lib/x.ts', 'lib/y.ts']);
  });
});

describe('summarizeScopeDiff', () => {
  it('includes counts and per-file lists', () => {
    const r = compareDiffToScope(
      ['lib/x.ts', 'app/sibling.ts', 'random.ts'],
      [{ filesInScope: ['lib/**'], filesOutOfScope: ['app/**'] }]
    );
    const text = summarizeScopeDiff(r);
    assert.match(text, /Scope-diff summary/);
    assert.match(text, /in scope: +1/);
    assert.match(text, /out of scope: +1/);
    assert.match(text, /unaccounted: +1/);
    assert.match(text, /Sibling-owned/);
    assert.match(text, /app\/sibling\.ts/);
    assert.match(text, /Unaccounted/);
    assert.match(text, /random\.ts/);
  });

  it('omits sections when their buckets are empty', () => {
    const r = compareDiffToScope(['lib/x.ts'], [{ filesInScope: ['lib/**'] }]);
    const text = summarizeScopeDiff(r);
    assert.doesNotMatch(text, /Sibling-owned/);
    assert.doesNotMatch(text, /Unaccounted/);
  });

  it('returns empty string for null', () => {
    assert.equal(summarizeScopeDiff(null), '');
  });
});
