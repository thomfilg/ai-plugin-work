const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Deferred require — the module may not exist yet in RED. Probe behaviorally.
const MODULE_PATH = path.join(__dirname, '..', 'envrc-resolver.js');

function loadModule() {
  if (!fs.existsSync(MODULE_PATH)) {
    return {
      __missing: true,
      findNearestEnvrc: () => null,
      findNearestPackageJson: () => null,
      resolveVar: () => null,
    };
  }
  return require(MODULE_PATH);
}

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('lib/envrc-resolver.js', () => {
  describe('findNearestEnvrc()', () => {
    it('walks up from startDir and returns { path, vars } when .envrc is in a parent dir (CLAUDE.md note)', () => {
      const root = mkdtemp('envrc-parent-');
      try {
        const parent = path.join(root, 'parent');
        const child = path.join(parent, 'child', 'grandchild');
        fs.mkdirSync(child, { recursive: true });
        fs.writeFileSync(path.join(parent, '.envrc'), 'export FOO=bar\n');

        const { findNearestEnvrc } = loadModule();
        const result = findNearestEnvrc(child);
        assert.ok(result, 'expected non-null result');
        assert.equal(result.path, path.join(parent, '.envrc'));
        assert.equal(result.vars.FOO, 'bar');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('returns null when no .envrc exists up the tree', () => {
      const root = mkdtemp('envrc-absent-');
      try {
        const child = path.join(root, 'a', 'b');
        fs.mkdirSync(child, { recursive: true });

        const { findNearestEnvrc } = loadModule();
        // Pass an absolute start dir that is itself isolated under tmpdir.
        // To make 'no envrc anywhere' deterministic, we accept null OR a
        // result whose path is NOT under our tmp root.
        const result = findNearestEnvrc(child);
        if (result !== null) {
          assert.ok(
            !result.path.startsWith(root),
            'no .envrc was created under the tmp root; resolver must not invent one'
          );
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('parses simple VAR=value and export VAR=value lines', () => {
      const root = mkdtemp('envrc-simple-');
      try {
        fs.writeFileSync(
          path.join(root, '.envrc'),
          ['export FOO=hello', 'BAR=world', '# a comment', ''].join('\n')
        );
        const { findNearestEnvrc } = loadModule();
        const result = findNearestEnvrc(root);
        assert.ok(result);
        assert.equal(result.vars.FOO, 'hello');
        assert.equal(result.vars.BAR, 'world');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('skips (rejects) command-substitution lines: $(…) and backticks', () => {
      const root = mkdtemp('envrc-cmdsub-');
      try {
        fs.writeFileSync(
          path.join(root, '.envrc'),
          ['export GOOD=ok', 'export BAD1=$(date)', 'export BAD2=`hostname`'].join('\n')
        );
        const { findNearestEnvrc } = loadModule();
        const result = findNearestEnvrc(root);
        assert.ok(result);
        assert.equal(result.vars.GOOD, 'ok');
        assert.ok(!('BAD1' in result.vars), 'command substitution $(...) must be rejected');
        assert.ok(!('BAD2' in result.vars), 'backtick substitution must be rejected');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('resolveVar()', () => {
    it('resolves a simple VAR=foo', () => {
      const { resolveVar } = loadModule();
      const envrc = { path: '/tmp/x/.envrc', vars: { FOO: 'foo' } };
      assert.equal(resolveVar('FOO', envrc), 'foo');
    });

    it('recursively expands $VAR and ${VAR} references', () => {
      const { resolveVar } = loadModule();
      const envrc = {
        path: '/tmp/x/.envrc',
        vars: { A: '$B', B: '${C}', C: 'done' },
      };
      assert.equal(resolveVar('A', envrc), 'done');
    });

    it('returns null on a cycle (and does not blow the stack)', () => {
      const { resolveVar } = loadModule();
      const envrc = {
        path: '/tmp/x/.envrc',
        vars: { A: '$B', B: '$A' },
      };
      assert.equal(resolveVar('A', envrc), null);
    });

    it('returns null when the var is unset', () => {
      const { resolveVar } = loadModule();
      const envrc = { path: '/tmp/x/.envrc', vars: { FOO: 'foo' } };
      assert.equal(resolveVar('MISSING', envrc), null);
    });
  });

  describe('findNearestPackageJson()', () => {
    it('walks up and returns { path, manifest }; manifest reads are memoized per call site', () => {
      const root = mkdtemp('pkg-walk-');
      try {
        const child = path.join(root, 'a', 'b', 'c');
        fs.mkdirSync(child, { recursive: true });
        const pkgPath = path.join(root, 'package.json');
        fs.writeFileSync(
          pkgPath,
          JSON.stringify({ name: 'tmp', scripts: { test: 'node --test' } })
        );

        const { findNearestPackageJson } = loadModule();
        const first = findNearestPackageJson(child);
        assert.ok(first);
        assert.equal(first.path, pkgPath);
        assert.equal(first.manifest.name, 'tmp');
        assert.equal(first.manifest.scripts.test, 'node --test');

        // Memoization contract (AC9): a second call for the same start dir
        // should not re-read from disk. We assert by mutating the file on
        // disk and confirming the returned manifest is the cached value.
        fs.writeFileSync(pkgPath, JSON.stringify({ name: 'CHANGED', scripts: {} }));
        const second = findNearestPackageJson(child);
        assert.ok(second);
        assert.equal(second.manifest.name, 'tmp', 'manifest must be cached per call site (AC9)');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
