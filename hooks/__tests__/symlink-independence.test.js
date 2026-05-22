/**
 * Regression tests: hook scripts must NOT depend on the legacy
 * `<plugin-root>/workflows -> scripts/workflows` symlink to resolve
 * their top-level requires.
 *
 * Historically `hooks/work-hook.js` and `hooks/enforce-follow-up-script.js`
 * computed module paths through a `workflows/...` segment that only
 * resolved via that committed symlink. If the symlink ever went away
 * (clean clone without symlinks, copy to a filesystem that strips them,
 * intentional refactor), Node would throw MODULE_NOT_FOUND from
 * loader:1459 at hook entry — visible to every /work invocation.
 *
 * These tests rebuild a minimal plugin root that has only the canonical
 * `scripts/workflows/...` layout (no `workflows` symlink), copy each
 * hook into it, and spawn it. A clean exit with no MODULE_NOT_FOUND
 * proves the hook's path resolution no longer depends on the symlink.
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const REAL_HOOKS_DIR = path.join(REPO_ROOT, 'hooks');
const REAL_SCRIPTS_WORKFLOWS = path.join(REPO_ROOT, 'scripts', 'workflows');

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isSymbolicLink()) {
      // Skip symlinks entirely — that's the whole point of this test.
      continue;
    }
    if (ent.isDirectory()) copyDirSync(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

describe('hook scripts resolve without the workflows symlink', () => {
  let tmpRoot;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-symlink-test-'));
    // Re-create plugin layout WITHOUT the `workflows -> scripts/workflows`
    // symlink. We copy only what the hooks need to load: scripts/workflows.
    copyDirSync(REAL_SCRIPTS_WORKFLOWS, path.join(tmpRoot, 'scripts', 'workflows'));
    // Copy hooks themselves into the synthetic root.
    copyDirSync(REAL_HOOKS_DIR, path.join(tmpRoot, 'hooks'));

    // Sanity: confirm no `workflows` entry exists at the synthetic root.
    assert.equal(
      fs.existsSync(path.join(tmpRoot, 'workflows')),
      false,
      'synthetic root must NOT contain a workflows symlink — the test fixture is broken'
    );
  });

  after(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('work-hook.js loads and exits 0 with no MODULE_NOT_FOUND on stderr', () => {
    const hook = path.join(tmpRoot, 'hooks', 'work-hook.js');
    const res = spawnSync(process.execPath, [hook], {
      input: '',
      env: { ...process.env, CLAUDE_USER_PROMPT: 'hello world', CLAUDE_PLUGIN_ROOT: tmpRoot },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr=${res.stderr}`);
    assert.ok(
      !/MODULE_NOT_FOUND/.test(res.stderr || ''),
      `unexpected MODULE_NOT_FOUND in stderr: ${res.stderr}`
    );
    assert.ok(
      !/loader:1459/.test(res.stderr || ''),
      `unexpected loader stack trace in stderr: ${res.stderr}`
    );
  });

  it('enforce-follow-up-script.js loads and exits 0 with no MODULE_NOT_FOUND on stderr', () => {
    const hook = path.join(tmpRoot, 'hooks', 'enforce-follow-up-script.js');
    // Feed a benign tool_input that won't match the gh-CI regex → early exit 0.
    const payload = JSON.stringify({ tool_input: { command: 'ls -la' } });
    const res = spawnSync(process.execPath, [hook], {
      input: payload,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: tmpRoot },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr=${res.stderr}`);
    assert.ok(
      !/MODULE_NOT_FOUND/.test(res.stderr || ''),
      `unexpected MODULE_NOT_FOUND in stderr: ${res.stderr}`
    );
  });

  it('work-hook.js still loads when CLAUDE_PLUGIN_ROOT is unset (uses __dirname)', () => {
    const hook = path.join(tmpRoot, 'hooks', 'work-hook.js');
    const env = { ...process.env, CLAUDE_USER_PROMPT: 'hello world' };
    delete env.CLAUDE_PLUGIN_ROOT;
    const res = spawnSync(process.execPath, [hook], {
      input: '',
      env,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr=${res.stderr}`);
    assert.ok(
      !/MODULE_NOT_FOUND/.test(res.stderr || ''),
      `unexpected MODULE_NOT_FOUND in stderr: ${res.stderr}`
    );
  });
});
