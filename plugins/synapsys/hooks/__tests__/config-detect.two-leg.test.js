'use strict';

/**
 * WP-05: two-leg require for the factories/envConfig escapes.
 *
 * Codex (and any cache-isolated install) snapshots each plugin dir WITHOUT
 * the repo-root factories/ tree, so the old
 * `require('../../../factories/envConfig/...')` crashed with
 * MODULE_NOT_FOUND. config-detect.js now runs the vendored
 * lib/runtime/envconfig-lite first; config-cli.js degrades to the vendored
 * detect-only pass when factories/ is absent. These tests simulate the cache
 * install by copying ONLY the plugin-shaped files into a tmp dir (no
 * factories/ above it) and spawning the real entrypoints.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

function makeCacheInstall() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-cache-install-'));
  const plugin = path.join(base, 'plugin');
  fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  fs.cpSync(path.join(PLUGIN_ROOT, 'lib', 'runtime'), path.join(plugin, 'lib', 'runtime'), {
    recursive: true,
  });
  fs.copyFileSync(
    path.join(PLUGIN_ROOT, 'hooks', 'config-detect.js'),
    path.join(plugin, 'hooks', 'config-detect.js')
  );
  fs.copyFileSync(
    path.join(PLUGIN_ROOT, 'scripts', 'config-cli.js'),
    path.join(plugin, 'scripts', 'config-cli.js')
  );
  fs.writeFileSync(
    path.join(plugin, 'config-schema.json'),
    JSON.stringify({
      plugin: 'synapsys',
      vars: { SYNAPSYS_TEST_FAKE_VAR_WP05: { description: 'fixture-only var' } },
    })
  );
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { plugin, home, cwd };
}

function spawnEntry(file, { input = '', home, cwd, env = {} }) {
  const childEnv = {
    ...process.env,
    HOME: home,
    CLAUDE_PROJECT_DIR: '',
    AGENT_RUNTIME: '',
    CODEX_THREAD_ID: '',
    PLUGIN_ROOT: '',
    ...env,
  };
  // An env var that is merely EMPTY still counts as set for detection —
  // the fixture var must be truly absent from the child env.
  delete childEnv.SYNAPSYS_TEST_FAKE_VAR_WP05;
  const res = spawnSync(process.execPath, [file], {
    input,
    cwd,
    encoding: 'utf8',
    env: childEnv,
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

test('config-detect runs standalone in a cache-isolated install (no factories/)', () => {
  const { plugin, home, cwd } = makeCacheInstall();
  const r = spawnEntry(path.join(plugin, 'hooks', 'config-detect.js'), {
    input: JSON.stringify({ cwd }),
    home,
    cwd,
  });
  assert.equal(r.status, 0, `config-detect crashed: ${r.stderr}`);
  assert.match(r.stdout, /⚙ synapsys: 1 unconfigured config var\(s\): SYNAPSYS_TEST_FAKE_VAR_WP05/);
  assert.match(r.stdout, /Run \/synapsys:configure to set them up/);
});

test('config-detect renders the configure command through the vocab layer on codex', () => {
  const { plugin, home, cwd } = makeCacheInstall();
  const r = spawnEntry(path.join(plugin, 'hooks', 'config-detect.js'), {
    input: JSON.stringify({ cwd }),
    home,
    cwd,
    env: { AGENT_RUNTIME: 'codex' },
  });
  assert.equal(r.status, 0, `config-detect crashed: ${r.stderr}`);
  assert.match(r.stdout, /Run the \$configure skill \(synapsys:configure\) to set them up/);
});

test('config-detect on the dev tree still exits 0 (fail-open contract)', () => {
  const { home, cwd } = makeCacheInstall();
  const r = spawnEntry(path.join(PLUGIN_ROOT, 'hooks', 'config-detect.js'), {
    input: JSON.stringify({ cwd }),
    home,
    cwd,
  });
  assert.equal(r.status, 0, `config-detect crashed: ${r.stderr}`);
});

test('config-cli degrades to the vendored detect-only pass in a cache install', () => {
  const { plugin, home, cwd } = makeCacheInstall();
  const r = spawnEntry(path.join(plugin, 'scripts', 'config-cli.js'), { home, cwd });
  assert.equal(r.status, 0, `config-cli crashed: ${r.stderr}`);
  assert.match(r.stderr, /ran the vendored detect-only pass/);
  assert.match(r.stdout, /SYNAPSYS_TEST_FAKE_VAR_WP05/);
});
