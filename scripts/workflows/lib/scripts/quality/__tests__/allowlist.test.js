'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ALLOWLIST_PATH = path.join(__dirname, '..', 'shared', 'allowlist.js');

function loadAllowlist() {
  delete require.cache[require.resolve(ALLOWLIST_PATH)];
  return require(ALLOWLIST_PATH);
}

function mkRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('allowlist: missing .quality-exceptions returns empty Set (not an error)', () => {
  const { AllowlistLoader } = loadAllowlist();
  const repo = mkRepo();
  try {
    const result = AllowlistLoader.load(repo);
    assert.ok(result instanceof Set);
    assert.equal(result.size, 0);
  } finally {
    cleanup(repo);
  }
});

test('allowlist: parses entries, drops blanks and # comments, trims whitespace', () => {
  const { AllowlistLoader } = loadAllowlist();
  const repo = mkRepo();
  try {
    fs.writeFileSync(
      path.join(repo, '.quality-exceptions'),
      [
        '# header comment',
        '',
        '  scripts/foo.js  ',
        '# inline comment line',
        'lib/bar.js',
        '',
      ].join('\n')
    );
    const result = AllowlistLoader.load(repo);
    assert.ok(result instanceof Set);
    assert.equal(result.size, 2);
    assert.ok(result.has('scripts/foo.js'));
    assert.ok(result.has('lib/bar.js'));
  } finally {
    cleanup(repo);
  }
});

test('allowlist: normalizes paths via path.normalize', () => {
  const { AllowlistLoader } = loadAllowlist();
  const repo = mkRepo();
  try {
    fs.writeFileSync(
      path.join(repo, '.quality-exceptions'),
      'scripts//foo/./bar.js\n'
    );
    const result = AllowlistLoader.load(repo);
    // path.normalize('scripts//foo/./bar.js') === 'scripts/foo/bar.js'
    assert.ok(result.has(path.normalize('scripts/foo/bar.js')));
  } finally {
    cleanup(repo);
  }
});

test('allowlist: rejects entries containing ".."', () => {
  const { AllowlistLoader } = loadAllowlist();
  const repo = mkRepo();
  try {
    fs.writeFileSync(
      path.join(repo, '.quality-exceptions'),
      '../escape.js\n'
    );
    assert.throws(
      () => AllowlistLoader.load(repo),
      /\.\./
    );
  } finally {
    cleanup(repo);
  }
});

test('allowlist: rejects absolute paths', () => {
  const { AllowlistLoader } = loadAllowlist();
  const repo = mkRepo();
  try {
    fs.writeFileSync(
      path.join(repo, '.quality-exceptions'),
      '/etc/passwd\n'
    );
    assert.throws(
      () => AllowlistLoader.load(repo),
      /absolute/i
    );
  } finally {
    cleanup(repo);
  }
});
