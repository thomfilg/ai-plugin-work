'use strict';

/**
 * Tests for scopeEntryAdmitsOnlyTestFiles helper in task-next.js.
 *
 * Context (cursor[bot] review, GH-528): the tests-only GREEN gate
 * previously rejected any `### Files in scope` entry that did not itself
 * end in `*.test.*` / `*.spec.*`. That worked for literal paths but
 * mis-classified glob entries whose basename DOES constrain to test
 * files (e.g. `plugins/work/**\/*.test.js` — match set is test-only)
 * while correctly rejecting open-ended globs like `src/**` whose match
 * set admits non-test files.
 *
 * Rule: an entry "admits only test files" when EITHER
 *   (a) it is a literal path matching `*.test.<ext>` / `*.spec.<ext>`, OR
 *   (b) it is a glob whose final segment (basename) ends in a test-file
 *       extension pattern.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const taskNext = require('../task-next.js');

describe('scopeEntryAdmitsOnlyTestFiles (tests-only GREEN scope classifier)', () => {
  it('is exported from task-next.js', () => {
    assert.equal(
      typeof taskNext.scopeEntryAdmitsOnlyTestFiles,
      'function',
      'scopeEntryAdmitsOnlyTestFiles must be a named export of task-next.js'
    );
  });

  it('accepts a literal test-file path', () => {
    const { scopeEntryAdmitsOnlyTestFiles } = taskNext;
    assert.equal(scopeEntryAdmitsOnlyTestFiles('src/foo.test.js'), true);
    assert.equal(scopeEntryAdmitsOnlyTestFiles('plugins/x/a.spec.tsx'), true);
  });

  it('rejects a literal non-test path', () => {
    const { scopeEntryAdmitsOnlyTestFiles } = taskNext;
    assert.equal(scopeEntryAdmitsOnlyTestFiles('src/foo.js'), false);
    assert.equal(scopeEntryAdmitsOnlyTestFiles('lib/index.ts'), false);
  });

  it('accepts a glob whose basename constrains to test files', () => {
    const { scopeEntryAdmitsOnlyTestFiles } = taskNext;
    assert.equal(scopeEntryAdmitsOnlyTestFiles('plugins/work/**/*.test.js'), true);
    assert.equal(scopeEntryAdmitsOnlyTestFiles('src/foo/**/*.spec.tsx'), true);
    assert.equal(scopeEntryAdmitsOnlyTestFiles('**/*.test.ts'), true);
  });

  it('rejects an open-ended glob whose match set could include non-tests', () => {
    const { scopeEntryAdmitsOnlyTestFiles } = taskNext;
    assert.equal(scopeEntryAdmitsOnlyTestFiles('src/**'), false);
    assert.equal(scopeEntryAdmitsOnlyTestFiles('lib/**/*.js'), false);
    assert.equal(scopeEntryAdmitsOnlyTestFiles('plugins/work/**'), false);
  });

  it('rejects empty / non-string entries', () => {
    const { scopeEntryAdmitsOnlyTestFiles } = taskNext;
    assert.equal(scopeEntryAdmitsOnlyTestFiles(''), false);
    assert.equal(scopeEntryAdmitsOnlyTestFiles(null), false);
    assert.equal(scopeEntryAdmitsOnlyTestFiles(undefined), false);
    assert.equal(scopeEntryAdmitsOnlyTestFiles(42), false);
  });
});
