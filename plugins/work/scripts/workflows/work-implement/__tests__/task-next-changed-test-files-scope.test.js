/**
 * Tests for filterChangedTestFilesByScope helper in task-next.js.
 *
 * Cursor comment #3377758763 (Review Comment 4 — Medium):
 *
 *   detectChangedTestFilesInScope treats scope with exact paths or
 *   directory prefixes only; it does not use the existing
 *   fileMatchesScope glob logic. Tasks whose `### Files in scope` lists
 *   patterns like `src/**` will not count modified in-scope test files,
 *   so `Type=tests-only` GREEN can block even when the agent edited the
 *   right tests.
 *
 * The pure helper `filterChangedTestFilesByScope(changedPaths, scope)`
 * applies the same two filters that the production callsite applies
 * (test-file extension AND scope match) but without the git lookup, so
 * the scope-match semantics can be exercised directly.
 *
 * Run with:
 *   node --test scripts/workflows/work-implement/__tests__/task-next-changed-test-files-scope.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const taskNext = require('../task-next');

describe('filterChangedTestFilesByScope (glob-aware scope matching for tests-only GREEN)', () => {
  it('is exported as a named export of task-next.js', () => {
    assert.equal(
      typeof taskNext.filterChangedTestFilesByScope,
      'function',
      'filterChangedTestFilesByScope must be a named export of task-next.js'
    );
  });

  it('keeps a changed test file matched by an exact scope entry (legacy behavior)', () => {
    const { filterChangedTestFilesByScope } = taskNext;
    const result = filterChangedTestFilesByScope(
      ['plugins/work/scripts/foo.test.js'],
      ['plugins/work/scripts/foo.test.js']
    );
    assert.deepEqual(result, ['plugins/work/scripts/foo.test.js']);
  });

  it('keeps a changed test file matched by a directory-prefix scope entry (legacy behavior)', () => {
    const { filterChangedTestFilesByScope } = taskNext;
    const result = filterChangedTestFilesByScope(
      ['plugins/work/scripts/sub/foo.test.js'],
      ['plugins/work/scripts/sub']
    );
    assert.deepEqual(result, ['plugins/work/scripts/sub/foo.test.js']);
  });

  it('keeps a changed test file matched by a `**` glob scope entry (regression fix)', () => {
    const { filterChangedTestFilesByScope } = taskNext;
    const result = filterChangedTestFilesByScope(
      ['plugins/work/scripts/workflows/work-implement/__tests__/x.test.js'],
      ['plugins/work/**/*.test.js']
    );
    assert.deepEqual(result, ['plugins/work/scripts/workflows/work-implement/__tests__/x.test.js']);
  });

  it('keeps a changed test file matched by a single-`*` glob segment', () => {
    const { filterChangedTestFilesByScope } = taskNext;
    const result = filterChangedTestFilesByScope(
      ['plugins/work/scripts/foo.test.js'],
      ['plugins/work/scripts/*.test.js']
    );
    assert.deepEqual(result, ['plugins/work/scripts/foo.test.js']);
  });

  it('excludes a non-test file even when it matches the scope glob', () => {
    const { filterChangedTestFilesByScope } = taskNext;
    const result = filterChangedTestFilesByScope(
      ['plugins/work/scripts/foo.js', 'plugins/work/scripts/foo.test.js'],
      ['plugins/work/**']
    );
    assert.deepEqual(result, ['plugins/work/scripts/foo.test.js']);
  });

  it('excludes a changed test file outside the scope glob', () => {
    const { filterChangedTestFilesByScope } = taskNext;
    const result = filterChangedTestFilesByScope(
      ['unrelated/elsewhere/bar.test.js'],
      ['plugins/work/**/*.test.js']
    );
    assert.deepEqual(result, []);
  });

  it('falls back to "any changed test file" when scope is empty', () => {
    const { filterChangedTestFilesByScope } = taskNext;
    const result = filterChangedTestFilesByScope(['anywhere/x.test.js', 'anywhere/y.js'], []);
    assert.deepEqual(result, ['anywhere/x.test.js']);
  });
});
