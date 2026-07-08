/**
 * Tests for scripts/lint-symlink-paths.js (WP-10 — design §G/C10).
 *
 * Proves:
 *   - the static layer is clean on the real tree and flags `/workflows/`
 *     paths that bypass `scripts/workflows`
 *   - copyWithoutSymlinks reproduces the codex install snapshot (symlinks
 *     STRIPPED, files copied)
 *   - the stripped-tree entrypoint probe catches a hook that requires
 *     through the `workflows/` symlink (MODULE_NOT_FOUND) — and the real
 *     plugins' hook entrypoints all load clean in stripped copies
 *
 * Run with: node --test scripts/__tests__/lint-symlink-paths.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const LINT_PATH = path.join(REPO_ROOT, 'scripts', 'lint-symlink-paths.js');
const { staticViolations, hookCommands, copyWithoutSymlinks } = require(LINT_PATH);

const PLUGINS = ['heimdall', 'maestro', 'synapsys', 'work'];

/** A minimal fake plugin whose hook requires THROUGH the workflows symlink. */
function fakeSymlinkPlugin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-symlink-fixture-'));
  fs.mkdirSync(path.join(dir, 'scripts', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'workflows', 'real.js'), 'module.exports = 1;\n');
  fs.symlinkSync(path.join('scripts', 'workflows'), path.join(dir, 'workflows'));
  fs.writeFileSync(
    path.join(dir, 'hooks', 'bad.js'),
    'require(`${process.env.CLAUDE_PLUGIN_ROOT}/workflows/real.js`);\n'
  );
  return dir;
}

describe('lint-symlink-paths — static layer', () => {
  it('is clean on the real tree', () => {
    assert.deepStrictEqual(staticViolations(), []);
  });

  it('every plugin contributes hook entrypoint commands', () => {
    for (const plugin of PLUGINS) {
      const commands = hookCommands(path.join(REPO_ROOT, 'plugins', plugin));
      assert.ok(commands.length > 0, `${plugin} has no hook commands`);
      for (const cmd of commands) {
        assert.ok(!/(?<!scripts)\/workflows\//.test(cmd), `${plugin}: ${cmd}`);
      }
    }
  });
});

describe('lint-symlink-paths — stripped-tree probe', () => {
  it('copyWithoutSymlinks strips symlinks and keeps files', () => {
    const src = fakeSymlinkPlugin();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-symlink-copy-'));
    copyWithoutSymlinks(src, dest);
    assert.ok(fs.existsSync(path.join(dest, 'scripts', 'workflows', 'real.js')));
    assert.ok(!fs.existsSync(path.join(dest, 'workflows')), 'symlink must be stripped');
  });

  it('a require through the symlink dies with MODULE_NOT_FOUND in the stripped copy', () => {
    const src = fakeSymlinkPlugin();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-symlink-copy-'));
    copyWithoutSymlinks(src, dest);
    const inLinkedTree = spawnSync('bash', ['-c', 'node "${CLAUDE_PLUGIN_ROOT}/hooks/bad.js"'], {
      env: { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: src },
      encoding: 'utf8',
    });
    assert.strictEqual(inLinkedTree.status, 0, 'works via the symlink (Claude dev tree)');
    const inStrippedTree = spawnSync('bash', ['-c', 'node "${CLAUDE_PLUGIN_ROOT}/hooks/bad.js"'], {
      env: { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: dest },
      encoding: 'utf8',
    });
    assert.notStrictEqual(inStrippedTree.status, 0);
    assert.match(inStrippedTree.stderr, /Cannot find module/);
  });

  it('the full lint (static + real entrypoint probes) exits 0', { timeout: 180000 }, () => {
    const res = spawnSync('node', [LINT_PATH], { encoding: 'utf8', timeout: 170000 });
    assert.strictEqual(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stdout, /static \+ stripped-tree entrypoints/);
  });
});
