'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs, writeTarget, varInventory } = require('../cli');

const CLI = path.join(__dirname, '..', 'cli.js');

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
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'envcfg-cli-'));
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

test('parseArgs handles flags with and without values', () => {
  const args = parseArgs(['plan', '--plugin-root', '/x', '--all', '--cwd', '/y']);
  assert.deepEqual(args._, ['plan']);
  assert.equal(args['plugin-root'], '/x');
  assert.equal(args.all, true);
  assert.equal(args.cwd, '/y');
});

test('varInventory reflects current values and sources', () => {
  const inventory = varInventory([schema], {
    DEMO_NAME: { value: 'set', dynamic: false, source: 'envrc' },
  });
  const byName = Object.fromEntries(inventory.map((v) => [v.name, v]));
  assert.equal(byName.DEMO_NAME.current, 'set');
  assert.equal(byName.DEMO_NAME.source, 'envrc');
  assert.equal(byName.DEMO_NAME.required, true);
  assert.equal(byName.DEMO_FLAG.current, null);
});

test('writeTarget renders a fresh .envrc, merges an existing one', () => {
  const envrcPath = path.join(tmp, 'wrapper', '.envrc');
  const rendered = writeTarget(
    {
      target: 'envrc',
      envrcPath,
      ghUser: 'someone',
      gitIdentity: { mode: 'default' },
      values: { DEMO_NAME: 'fresh' },
    },
    [schema]
  );
  assert.equal(rendered.mode, 'render');
  const content = fs.readFileSync(envrcPath, 'utf8');
  assert.match(content, /gh auth token -u someone/);
  assert.match(content, /export DEMO_NAME=fresh/);

  const merged = writeTarget({ target: 'envrc', envrcPath, values: { DEMO_FLAG: '1' } }, [schema]);
  assert.equal(merged.mode, 'merge');
  assert.ok(merged.backup && fs.existsSync(merged.backup), 'backup kept');
  const after = fs.readFileSync(envrcPath, 'utf8');
  assert.match(after, /export DEMO_NAME=fresh/, 'existing content preserved');
  assert.match(after, /^export DEMO_FLAG=1$/m);
  fs.rmSync(merged.backup);
});

test('writeTarget merges into .env without export prefixes', () => {
  const envPath = path.join(tmp, '.env');
  fs.writeFileSync(envPath, 'EXISTING=1\n');
  writeTarget({ target: 'env', envPath, values: { DEMO_NAME: 'x' } }, [schema]);
  const content = fs.readFileSync(envPath, 'utf8');
  assert.match(content, /^EXISTING=1$/m);
  assert.match(content, /^DEMO_NAME=x$/m);
});

test('cli plan/detect/validate round-trip against a fixture plugin', () => {
  const pluginRoot = makePluginDir();
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home };

  const plan = spawnSync(
    process.execPath,
    [CLI, 'plan', '--plugin-root', pluginRoot, '--cwd', tmp],
    {
      encoding: 'utf8',
      env,
    }
  );
  assert.equal(plan.status, 0, plan.stderr);
  const parsed = JSON.parse(plan.stdout);
  assert.deepEqual(parsed.plugins, ['demo']);
  assert.equal(parsed.vars.length, 2);

  const detect = spawnSync(
    process.execPath,
    [CLI, 'detect', '--plugin-root', pluginRoot, '--cwd', tmp],
    { encoding: 'utf8', env }
  );
  assert.equal(detect.status, 0, detect.stderr);
  const detected = JSON.parse(detect.stdout);
  assert.equal(detected.changed, true);
  assert.deepEqual(detected.missing, ['DEMO_NAME', 'DEMO_FLAG']);

  fs.writeFileSync(path.join(tmp, '.envrc'), 'export DEMO_FLAG=maybe\n');
  const validate = spawnSync(
    process.execPath,
    [CLI, 'validate', '--plugin-root', pluginRoot, '--cwd', tmp],
    { encoding: 'utf8', env }
  );
  assert.equal(validate.status, 0, validate.stderr);
  assert.match(validate.stdout, /DEMO_FLAG=maybe is invalid — expected 0 or 1/);
});
