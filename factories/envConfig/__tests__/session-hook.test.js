'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('../sessionHook');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

const schema = {
  plugin: 'demo',
  prefixes: ['DEMO_'],
  vars: {
    DEMO_NAME: {
      type: 'string',
      default: '',
      description: 'name',
      section: 'Core',
      required: true,
    },
    DEMO_FLAG: { type: 'bool01', default: '0', description: 'flag', section: 'Core' },
  },
};

let tmp;
let cachePath;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'envcfg-hook-'));
  cachePath = path.join(tmp, 'cache.json');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makePluginDir() {
  const pluginRoot = path.join(tmp, 'plugin');
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, 'config-schema.json'), JSON.stringify(schema));
  return pluginRoot;
}

test('run nudges on first run and lists missing vars', () => {
  const output = run({
    pluginRoot: makePluginDir(),
    configureCommand: '/demo:configure',
    cachePath,
    cwd: tmp,
  });
  assert.match(output, /⚙ demo: 2 unconfigured config var\(s\): DEMO_NAME, DEMO_FLAG/);
  assert.match(output, /\/demo:configure/);
  assert.match(output, /first run/);
});

test('run warns on invalid values and prefixed typos', () => {
  fs.writeFileSync(
    path.join(tmp, '.envrc'),
    'export DEMO_NAME=x\nexport DEMO_FLAG=nope\nexport DEMO_FLAO=1\n'
  );
  const output = run({
    pluginRoot: makePluginDir(),
    configureCommand: '/demo:configure',
    cachePath,
    cwd: tmp,
  });
  assert.match(output, /DEMO_FLAG=nope is invalid — expected 0 or 1/);
  assert.match(output, /unknown config var DEMO_FLAO — did you mean DEMO_FLAG\?/);
});

test('run is silent once all vars are set (auto-acknowledge) and cached', () => {
  const pluginRoot = makePluginDir();
  fs.writeFileSync(path.join(tmp, '.envrc'), 'export DEMO_NAME=x\nexport DEMO_FLAG=1\n');
  assert.equal(run({ pluginRoot, configureCommand: '/d', cachePath, cwd: tmp }), '');
  // Cache now holds the hash — even with values gone, the fast path is silent.
  fs.rmSync(path.join(tmp, '.envrc'));
  assert.equal(run({ pluginRoot, configureCommand: '/d', cachePath, cwd: tmp }), '');
});

test('run nudges for scannable vars until acknowledged, even on the fast path', () => {
  const { markConfigured, projectKey } = require('../detect');
  const scanSchema = {
    plugin: 'demo',
    prefixes: ['DEMO_'],
    vars: {
      DEMO_DOCS: {
        type: 'string',
        default: '',
        description: 'docs',
        section: 'Docs',
        advanced: true,
        scan: { globs: ['.rulesync/rules/*.md'] },
      },
    },
  };
  const pluginRoot = path.join(tmp, 'scan-plugin');
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, 'config-schema.json'), JSON.stringify(scanSchema));
  fs.mkdirSync(path.join(tmp, '.rulesync', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.rulesync', 'rules', 'types.md'), '# types\n');

  // First run: no non-advanced vars missing → hash auto-absorbed, but the
  // scan nudge still fires (that's the "set to empty and forgotten" signal).
  const first = run({ pluginRoot, configureCommand: '/demo:configure', cachePath, cwd: tmp });
  assert.match(first, /📄 demo: 1 var\(s\) can be auto-filled .*DEMO_DOCS/);
  // Fast path (hash cached): still nudging.
  const second = run({ pluginRoot, configureCommand: '/demo:configure', cachePath, cwd: tmp });
  assert.match(second, /📄 demo/);
  // Acknowledged as keep-unset via a configure pass: silent.
  const { schemaHash } = require('../schema');
  markConfigured({
    cachePath,
    projectRoot: projectKey(tmp),
    plugin: 'demo',
    hash: schemaHash(scanSchema),
    acknowledgedVars: ['DEMO_DOCS'],
  });
  const third = run({ pluginRoot, configureCommand: '/demo:configure', cachePath, cwd: tmp });
  assert.ok(!third.includes('📄'), `expected no scan nudge, got: ${third}`);
});

test('run returns empty when the plugin has no schema', () => {
  const emptyRoot = path.join(tmp, 'no-schema');
  fs.mkdirSync(emptyRoot, { recursive: true });
  assert.equal(run({ pluginRoot: emptyRoot, configureCommand: '/d', cachePath, cwd: tmp }), '');
});

test('every plugin config-detect hook exits 0 and stays fail-open', () => {
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  for (const plugin of ['work', 'heimdall', 'synapsys', 'maestro']) {
    const hook = path.join(REPO_ROOT, 'plugins', plugin, 'hooks', 'config-detect.js');
    const result = spawnSync(process.execPath, [hook], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home, CLAUDE_PROJECT_DIR: tmp },
    });
    assert.equal(result.status, 0, `${plugin}: ${result.stderr}`);
  }
});
