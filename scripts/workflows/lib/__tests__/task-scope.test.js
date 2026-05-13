/**
 * Tests for lib/task-scope.js (Gate C validators).
 *
 * Run: node --test scripts/workflows/lib/__tests__/task-scope.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ts = require('../task-scope');

describe('validateTask', () => {
  it('passes when both sections are populated', () => {
    const errors = ts.validateTask({
      num: 1,
      filesInScope: ['lib/x.ts'],
      filesOutOfScope: ['lib/y.ts'],
    });
    assert.deepEqual(errors, []);
  });

  it('passes with empty filesOutOfScope (no siblings)', () => {
    const errors = ts.validateTask({
      num: 1,
      filesInScope: ['lib/x.ts'],
      filesOutOfScope: [],
    });
    assert.deepEqual(errors, []);
  });

  it('fails when both filesInScope and suggestedScope are missing', () => {
    const errors = ts.validateTask({ num: 2, filesOutOfScope: [] });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Task 2/);
    assert.match(errors[0], /Files in scope/);
  });

  it('fails when both filesInScope and suggestedScope are empty', () => {
    const errors = ts.validateTask({
      num: 3,
      filesInScope: [],
      suggestedScope: '',
      filesOutOfScope: [],
    });
    assert.equal(errors.length, 1);
  });

  it('accepts legacy suggestedScope as fallback when filesInScope is missing', () => {
    const errors = ts.validateTask({
      num: 5,
      filesInScope: [],
      suggestedScope: '- lib/x.ts',
      filesOutOfScope: [],
    });
    assert.deepEqual(errors, []);
  });

  it('fails when filesOutOfScope is non-array (malformed)', () => {
    const errors = ts.validateTask({ num: 4, filesInScope: ['x.ts'], filesOutOfScope: 'oops' });
    assert.match(errors.join('|'), /out of scope/);
  });

  it('tolerates missing filesOutOfScope (legacy task)', () => {
    const errors = ts.validateTask({ num: 6, filesInScope: ['x.ts'] });
    assert.deepEqual(errors, []);
  });

  it('handles non-object input gracefully', () => {
    assert.deepEqual(ts.validateTask(null), ['task must be an object']);
    assert.deepEqual(ts.validateTask(undefined), ['task must be an object']);
  });
});

describe('validateAll', () => {
  it('returns valid:true when all tasks pass', () => {
    const result = ts.validateAll([
      { num: 1, filesInScope: ['a.ts'], filesOutOfScope: [] },
      { num: 2, filesInScope: ['b.ts'], filesOutOfScope: ['c.ts'] },
    ]);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('aggregates errors across all tasks', () => {
    const result = ts.validateAll([
      { num: 1, filesInScope: [], filesOutOfScope: [] },
      { num: 2, filesOutOfScope: 'bad' },
    ]);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 2);
    assert.match(result.errors.join('|'), /Task 1/);
    assert.match(result.errors.join('|'), /Task 2/);
  });

  it('fails on empty or non-array input', () => {
    assert.equal(ts.validateAll([]).valid, false);
    assert.equal(ts.validateAll(null).valid, false);
    assert.equal(ts.validateAll(undefined).valid, false);
  });
});

describe('unionFilesInScope', () => {
  it('returns deduped union across tasks', () => {
    const out = ts.unionFilesInScope([
      { num: 1, filesInScope: ['a.ts', 'b.ts'] },
      { num: 2, filesInScope: ['b.ts', 'c.ts'] },
    ]);
    assert.deepEqual(out.sort(), ['a.ts', 'b.ts', 'c.ts']);
  });

  it('tolerates missing filesInScope', () => {
    const out = ts.unionFilesInScope([{ num: 1 }, { num: 2, filesInScope: ['x.ts'] }]);
    assert.deepEqual(out, ['x.ts']);
  });

  it('returns [] for non-array', () => {
    assert.deepEqual(ts.unionFilesInScope(null), []);
  });
});

describe('findTask', () => {
  it('finds by task num', () => {
    const tasks = [
      { num: 1, filesInScope: ['a'] },
      { num: 2, filesInScope: ['b'] },
    ];
    assert.equal(ts.findTask(tasks, 2).filesInScope[0], 'b');
  });

  it('returns null when not found', () => {
    assert.equal(ts.findTask([{ num: 1 }], 9), null);
  });

  it('returns null for bad input', () => {
    assert.equal(ts.findTask(null, 1), null);
    assert.equal(ts.findTask([{ num: 1 }], 'nope'), null);
  });
});
