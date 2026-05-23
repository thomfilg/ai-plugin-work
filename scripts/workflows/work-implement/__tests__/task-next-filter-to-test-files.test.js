/**
 * Tests for filterToTestFiles helper in task-next.js (Task 1 / R2).
 *
 * Scenario covered:
 *   - P0 #2 — CHANGED_FILES sanitized in RED
 *
 * Run with:
 *   node --test scripts/workflows/work-implement/__tests__/task-next-filter-to-test-files.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const taskNext = require('../task-next');

describe('filterToTestFiles (P0 #2 — CHANGED_FILES sanitized in RED)', () => {
  it('is exported as a named export of task-next.js', () => {
    assert.equal(
      typeof taskNext.filterToTestFiles,
      'function',
      'filterToTestFiles must be a named export of task-next.js',
    );
  });

  it('P0 #2 — CHANGED_FILES sanitized in RED: keeps only .test./.spec. entries from a mixed scope', () => {
    const { filterToTestFiles } = taskNext;
    const input = ['src/foo.js', 'src/foo.test.js', 'src/bar.spec.ts'];
    const result = filterToTestFiles(input);
    assert.deepEqual(result, ['src/foo.test.js', 'src/bar.spec.ts']);
  });

  it('returns an empty array when the scope contains only source entries', () => {
    const { filterToTestFiles } = taskNext;
    const result = filterToTestFiles(['src/foo.js', 'src/bar.ts', 'lib/baz.tsx']);
    assert.deepEqual(result, []);
  });

  it('matches all supported test extensions (.test/.spec × .js/.jsx/.ts/.tsx)', () => {
    const { filterToTestFiles } = taskNext;
    const input = [
      'a/x.test.js',
      'a/x.test.jsx',
      'a/x.test.ts',
      'a/x.test.tsx',
      'a/x.spec.js',
      'a/x.spec.jsx',
      'a/x.spec.ts',
      'a/x.spec.tsx',
      'a/x.js',
    ];
    const result = filterToTestFiles(input);
    assert.deepEqual(result, [
      'a/x.test.js',
      'a/x.test.jsx',
      'a/x.test.ts',
      'a/x.test.tsx',
      'a/x.spec.js',
      'a/x.spec.jsx',
      'a/x.spec.ts',
      'a/x.spec.tsx',
    ]);
  });
});
