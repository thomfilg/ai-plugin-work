// Task 2 — P0 #1: colocated test discovery in `findTestFilesInScope()`
// Spec ref: tasks.md §Task 2 / brief §P0#1.
//
// `findTestFilesInScope(repoRoot, scope)` must detect colocated tests
// (e.g. `foo.test.js` next to `foo.js`) in addition to the existing
// `__tests__/` / `tests/` directory walks.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findTestFilesInScope } = require('../task-next.js');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-next-colocated-'));
}

test('P0 #1 — colocated test discovery: finds <basename>.test.js next to source', () => {
  assert.equal(
    typeof findTestFilesInScope,
    'function',
    'findTestFilesInScope must be exported from task-next.js',
  );

  const tmp = makeTmp();
  try {
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'foo.js'), '// source\n');
    fs.writeFileSync(
      path.join(tmp, 'src', 'foo.test.js'),
      "require('node:test');\n",
    );

    const result = findTestFilesInScope(tmp, ['src/foo.js']);

    assert.ok(
      result instanceof Set,
      'findTestFilesInScope must return a Set',
    );

    const colocated = path.join(tmp, 'src', 'foo.test.js');
    const source = path.join(tmp, 'src', 'foo.js');

    assert.ok(
      result.has(colocated),
      `expected result to contain colocated test ${colocated}, got ${[...result].join(', ')}`,
    );
    assert.ok(
      !result.has(source),
      'result must not include the non-test source file',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P0 #1 — colocated test discovery: also supports .spec.ts colocated alongside source', () => {
  const tmp = makeTmp();
  try {
    fs.mkdirSync(path.join(tmp, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'pkg', 'bar.ts'), '// source\n');
    fs.writeFileSync(path.join(tmp, 'pkg', 'bar.spec.ts'), '// spec\n');

    const result = findTestFilesInScope(tmp, ['pkg/bar.ts']);

    const colocated = path.join(tmp, 'pkg', 'bar.spec.ts');
    assert.ok(
      result.has(colocated),
      `expected colocated .spec.ts at ${colocated}, got ${[...result].join(', ')}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P0 #1 control case — existing __tests__/ sibling walk still works', () => {
  const tmp = makeTmp();
  try {
    fs.mkdirSync(path.join(tmp, 'src', '__tests__'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'baz.js'), '// source\n');
    fs.writeFileSync(
      path.join(tmp, 'src', '__tests__', 'baz.test.js'),
      '// test\n',
    );

    // Scope on the directory exercises the directory-walk branch, which
    // must continue to find tests under __tests__/.
    const result = findTestFilesInScope(tmp, ['src']);

    const walked = path.join(tmp, 'src', '__tests__', 'baz.test.js');
    assert.ok(
      result.has(walked),
      `expected directory walk to find ${walked}, got ${[...result].join(', ')}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
