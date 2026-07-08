/**
 * Tests for scripts/codex-reinstall.sh (WP-11 — codex dev-loop reinstall)
 *
 * Proves:
 *   - the script parses (bash -n)
 *   - the default mode is a DRY-RUN: it exits 0, prints the full plan
 *     (remove ×4, marketplace re-add, add ×4, trust guidance) and NEVER
 *     invokes codex — verified by running with a PATH that has no codex
 *   - --bump in dry-run announces the plugin.json bumps without writing
 *   - unknown arguments are rejected with exit 2
 *
 * Run with: node --test scripts/__tests__/codex-reinstall.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'codex-reinstall.sh');
const PLUGIN_JSONS = ['work', 'synapsys', 'maestro', 'heimdall'].map((p) =>
  path.join(REPO_ROOT, 'plugins', p, '.claude-plugin', 'plugin.json')
);

function runScript(args = [], env = process.env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', reject);
  });
}

describe('codex-reinstall.sh', () => {
  it('parses under bash -n', async () => {
    const { code } = await new Promise((resolve, reject) => {
      const proc = spawn('bash', ['-n', SCRIPT], { stdio: 'ignore' });
      proc.on('close', (c) => resolve({ code: c }));
      proc.on('error', reject);
    });
    assert.equal(code, 0);
  });

  it('dry-run prints the full plan and exits 0 without a codex binary', async () => {
    // PATH stripped to the bare essentials: if the dry-run tried to exec
    // codex, the run would fail — proving nothing is invoked automatically.
    const env = { ...process.env, PATH: '/usr/bin:/bin' };
    const { code, stdout } = await runScript([], env);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /mode: {13}DRY-RUN — pass --yes to execute/);
    for (const plugin of ['work-workflow', 'synapsys', 'maestro', 'heimdall']) {
      assert.match(stdout, new RegExp(`would run: codex plugin remove ${plugin}`));
      assert.match(stdout, new RegExp(`would run: codex plugin add ${plugin}@work-workflow`));
    }
    assert.match(stdout, /would run: codex plugin marketplace add /);
    assert.match(stdout, /re-trust the hooks/);
    assert.match(stdout, /NEVER write \[hooks\.state\] trusted_hash/);
    assert.match(stdout, /runtime-doctor\.js/);
    assert.doesNotMatch(stdout, /^\+ codex/m); // no command actually executed
  });

  it('--bump dry-run announces bumps without writing plugin.json', async () => {
    const before = PLUGIN_JSONS.map((f) => fs.readFileSync(f, 'utf8'));
    const { code, stdout } = await runScript(['--bump']);
    assert.equal(code, 0);
    assert.match(stdout, /would bump: .*plugins\/work\/\.claude-plugin\/plugin\.json/);
    const after = PLUGIN_JSONS.map((f) => fs.readFileSync(f, 'utf8'));
    assert.deepEqual(after, before);
  });

  it('rejects unknown arguments with exit 2', async () => {
    const { code, stderr } = await runScript(['--bogus']);
    assert.equal(code, 2);
    assert.match(stderr, /unknown argument: --bogus/);
  });
});
