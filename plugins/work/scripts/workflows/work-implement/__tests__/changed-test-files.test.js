/**
 * GH-694 — extraction parity for lib/changed-test-files.js.
 *
 * filterChangedTestFilesByScope and detectChangedTestFilesInScope moved
 * VERBATIM from task-next.js into the shared module (same sibling pattern as
 * lib/red-load-failure.js) so the implement gate's tests-only GREEN trap can
 * apply the exact GH-528 recorder rule (unification invariant). task-next.js
 * requires and re-exports both, so this suite pins:
 *   - re-export identity (the gate and the recorder share ONE function object)
 *   - scope-filter parity against the fixtures from
 *     task-next-changed-test-files-scope.test.js
 *   - the git-aware wrapper's changed-set semantics (untracked counts,
 *     committed-unchanged does not)
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const lib = require('../lib/changed-test-files');
const taskNext = require('../task-next');

describe('changed-test-files.js — re-export identity (GH-694)', () => {
  it('task-next.js re-exports the SAME function objects', () => {
    assert.equal(
      taskNext.filterChangedTestFilesByScope,
      lib.filterChangedTestFilesByScope,
      'filterChangedTestFilesByScope must be the shared module function'
    );
    assert.equal(
      taskNext.detectChangedTestFilesInScope,
      lib.detectChangedTestFilesInScope,
      'detectChangedTestFilesInScope must be the shared module function'
    );
  });
});

describe('changed-test-files.js — filterChangedTestFilesByScope parity', () => {
  const f = lib.filterChangedTestFilesByScope;

  it('keeps a changed test file matched by an exact scope entry', () => {
    assert.deepEqual(
      f(['plugins/work/scripts/foo.test.js'], ['plugins/work/scripts/foo.test.js']),
      ['plugins/work/scripts/foo.test.js']
    );
  });

  it('keeps a changed test file matched by a directory-prefix scope entry', () => {
    assert.deepEqual(f(['plugins/work/scripts/sub/foo.test.js'], ['plugins/work/scripts/sub']), [
      'plugins/work/scripts/sub/foo.test.js',
    ]);
  });

  it('keeps a changed test file matched by a `**` glob scope entry', () => {
    assert.deepEqual(
      f(
        ['plugins/work/scripts/workflows/work-implement/__tests__/x.test.js'],
        ['plugins/work/**/*.test.js']
      ),
      ['plugins/work/scripts/workflows/work-implement/__tests__/x.test.js']
    );
  });

  it('excludes a non-test file even when it matches the scope glob', () => {
    assert.deepEqual(
      f(['plugins/work/scripts/foo.js', 'plugins/work/scripts/foo.test.js'], ['plugins/work/**']),
      ['plugins/work/scripts/foo.test.js']
    );
  });

  it('excludes a changed test file outside the scope glob', () => {
    assert.deepEqual(f(['unrelated/elsewhere/bar.test.js'], ['plugins/work/**/*.test.js']), []);
  });

  it('falls back to "any changed test file" when scope is empty', () => {
    assert.deepEqual(f(['anywhere/x.test.js', 'anywhere/y.js'], []), ['anywhere/x.test.js']);
  });
});

describe('changed-test-files.js — detectChangedTestFilesInScope (git-aware wrapper)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-git-'));

  after(() => {
    try {
      fs.rmSync(repo, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  function git(...args) {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  }

  it('committed-unchanged suite yields none; a new untracked in-scope test file counts', () => {
    git('init', '-q');
    fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'tests', 'existing.test.js'), 'pre-existing\n');
    git('add', '.');
    git(
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'user.name=fixture',
      'commit',
      '-q',
      '-m',
      'seed'
    );

    assert.deepEqual(
      lib.detectChangedTestFilesInScope(repo, ['tests']),
      [],
      'byte-identical committed test files are not "changed"'
    );

    fs.writeFileSync(path.join(repo, 'tests', 'new-parity.test.js'), 'new test\n');
    assert.deepEqual(
      lib.detectChangedTestFilesInScope(repo, ['tests']),
      ['tests/new-parity.test.js'],
      'untracked in-scope test files count as changed'
    );
  });
});
