'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const scope = require('../lib/phases/scope_exists');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-exists-'));
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeTasksMd(repoRoot, body) {
  const tasksDir = path.join(repoRoot, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, 'tasks.md'), body);
  return tasksDir;
}

test('parseScopeEntries: bullet with no marker → null marker', () => {
  const entries = scope.parseScopeEntries('- `lib/foo.ts`\n');
  assert.deepEqual(entries, [{ path: 'lib/foo.ts', marker: null }]);
});

test('parseScopeEntries: (NEW) marker recognized', () => {
  const entries = scope.parseScopeEntries('- `lib/foo.ts` (NEW) — being created\n');
  assert.deepEqual(entries, [{ path: 'lib/foo.ts', marker: 'NEW' }]);
});

test('parseScopeEntries: (DELETE) marker recognized', () => {
  const entries = scope.parseScopeEntries('- `lib/old.ts` (DELETE)\n');
  assert.deepEqual(entries, [{ path: 'lib/old.ts', marker: 'DELETE' }]);
});

test('parseScopeEntries: case-insensitive marker', () => {
  const entries = scope.parseScopeEntries('- `a` (new)\n- `b` (Delete)\n');
  assert.deepEqual(entries, [
    { path: 'a', marker: 'NEW' },
    { path: 'b', marker: 'DELETE' },
  ]);
});

test('parseScopeEntries: ignores non-bullet lines', () => {
  const entries = scope.parseScopeEntries('some prose\n- `lib/x.ts`\nmore prose\n');
  assert.deepEqual(entries, [{ path: 'lib/x.ts', marker: null }]);
});

test('PLACEHOLDER_RE catches angle-bracket placeholders', () => {
  assert.match('.github/workflows/<ci-file>.yml', scope.PLACEHOLDER_RE);
  assert.match('lib/<thing>.ts', scope.PLACEHOLDER_RE);
});

test('PLACEHOLDER_RE catches curly placeholders', () => {
  assert.match('lib/{component}.tsx', scope.PLACEHOLDER_RE);
});

test('PLACEHOLDER_RE catches TBD / XXX / ???', () => {
  assert.match('path/TBD/foo.ts', scope.PLACEHOLDER_RE);
  assert.match('path/XXX/foo.ts', scope.PLACEHOLDER_RE);
  assert.match('path/???/foo.ts', scope.PLACEHOLDER_RE);
});

test('PLACEHOLDER_RE does not flag normal paths', () => {
  assert.doesNotMatch('.github/workflows/ci.yml', scope.PLACEHOLDER_RE);
  assert.doesNotMatch('lib/foo/bar.ts', scope.PLACEHOLDER_RE);
  assert.doesNotMatch('tests/e2e/x.spec.ts', scope.PLACEHOLDER_RE);
});

test('pathOrPrefixExists: exact file', () => {
  const dir = makeRepo();
  try {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib/foo.ts'), '');
    assert.equal(scope.pathOrPrefixExists('lib/foo.ts', dir), true);
    assert.equal(scope.pathOrPrefixExists('lib/missing.ts', dir), false);
  } finally {
    cleanup(dir);
  }
});

test('pathOrPrefixExists: leading ./ tolerated', () => {
  const dir = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'a.ts'), '');
    assert.equal(scope.pathOrPrefixExists('./a.ts', dir), true);
  } finally {
    cleanup(dir);
  }
});

test('pathOrPrefixExists: glob accepted when prefix dir exists', () => {
  const dir = makeRepo();
  try {
    fs.mkdirSync(path.join(dir, 'lib/foo'), { recursive: true });
    assert.equal(scope.pathOrPrefixExists('lib/foo/**/*.ts', dir), true);
    assert.equal(scope.pathOrPrefixExists('lib/missing/**/*.ts', dir), false);
  } finally {
    cleanup(dir);
  }
});

test('pathOrPrefixExists: top-level glob accepted unverified', () => {
  const dir = makeRepo();
  try {
    assert.equal(scope.pathOrPrefixExists('*.md', dir), true);
  } finally {
    cleanup(dir);
  }
});

test('validateBlock: placeholder path is blocked even with (NEW) marker', () => {
  const dir = makeRepo();
  try {
    const errs = scope.validateBlock(
      {
        num: 1,
        type: 'devops',
        entries: [{ path: '.github/workflows/<ci-file>.yml', marker: 'NEW' }],
      },
      dir
    );
    assert.equal(errs.length, 1);
    assert.match(errs[0], /placeholder path/);
    assert.match(errs[0], /<ci-file>/);
  } finally {
    cleanup(dir);
  }
});

test('validateBlock: missing file with no marker → error', () => {
  const dir = makeRepo();
  try {
    const errs = scope.validateBlock(
      { num: 2, type: 'backend', entries: [{ path: 'lib/missing.ts', marker: null }] },
      dir
    );
    assert.equal(errs.length, 1);
    assert.match(errs[0], /does not exist/);
    assert.match(errs[0], /\(NEW\)/);
  } finally {
    cleanup(dir);
  }
});

test('validateBlock: missing file with (NEW) marker → ok', () => {
  const dir = makeRepo();
  try {
    const errs = scope.validateBlock(
      { num: 3, type: 'frontend', entries: [{ path: 'components/NewThing.tsx', marker: 'NEW' }] },
      dir
    );
    assert.deepEqual(errs, []);
  } finally {
    cleanup(dir);
  }
});

test('validateBlock: missing file with (DELETE) marker → error', () => {
  const dir = makeRepo();
  try {
    const errs = scope.validateBlock(
      { num: 4, type: 'backend', entries: [{ path: 'lib/old.ts', marker: 'DELETE' }] },
      dir
    );
    assert.equal(errs.length, 1);
    assert.match(errs[0], /\(DELETE\)/);
    assert.match(errs[0], /does not exist/);
  } finally {
    cleanup(dir);
  }
});

test('validateBlock: existing file with no marker → ok', () => {
  const dir = makeRepo();
  try {
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib/exists.ts'), '');
    const errs = scope.validateBlock(
      { num: 5, type: 'backend', entries: [{ path: 'lib/exists.ts', marker: null }] },
      dir
    );
    assert.deepEqual(errs, []);
  } finally {
    cleanup(dir);
  }
});

test('validateBlock: checkpoint task is skipped entirely', () => {
  const dir = makeRepo();
  try {
    const errs = scope.validateBlock(
      {
        num: 6,
        type: 'checkpoint',
        entries: [{ path: '<placeholder>.ts', marker: null }],
      },
      dir
    );
    assert.deepEqual(errs, []);
  } finally {
    cleanup(dir);
  }
});

test('validateArtifacts: catches the ECHO-5137 wedge', () => {
  const dir = makeRepo();
  try {
    const tasksDir = writeTasksMd(
      dir,
      [
        '## Task 1',
        '### Type',
        'devops',
        '### Files in scope',
        '- `.github/workflows/<ci-file>.yml` (MODIFY — exact filename identified during implementation)',
        '',
      ].join('\n')
    );
    const errs = scope.validateArtifacts(tasksDir, dir);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /placeholder path/);
  } finally {
    cleanup(dir);
  }
});

test('validateArtifacts: ok when paths exist or are (NEW)', () => {
  const dir = makeRepo();
  try {
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib/real.ts'), '');
    const tasksDir = writeTasksMd(
      dir,
      [
        '## Task 1',
        '### Type',
        'backend',
        '### Files in scope',
        '- `lib/real.ts`',
        '- `lib/__tests__/real.integration.test.ts` (NEW)',
        '',
      ].join('\n')
    );
    const errs = scope.validateArtifacts(tasksDir, dir);
    assert.deepEqual(errs, []);
  } finally {
    cleanup(dir);
  }
});

test('validateArtifacts: no tasks.md → error', () => {
  const dir = makeRepo();
  try {
    const tasksDir = path.join(dir, 'tasks');
    fs.mkdirSync(tasksDir);
    const errs = scope.validateArtifacts(tasksDir, dir);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /Missing/);
  } finally {
    cleanup(dir);
  }
});

test('validateArtifacts: tasks.md without Task blocks → error', () => {
  const dir = makeRepo();
  try {
    const tasksDir = writeTasksMd(dir, '# Just a header\n\nNo tasks here.\n');
    const errs = scope.validateArtifacts(tasksDir, dir);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /No `## Task N` blocks/);
  } finally {
    cleanup(dir);
  }
});
