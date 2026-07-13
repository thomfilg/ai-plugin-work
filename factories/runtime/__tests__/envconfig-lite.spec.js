/**
 * Tests for factories/runtime/envconfig-lite.js — the detect+nudge subset of
 * factories/envConfig. The drift nudge output is asserted BYTE-IDENTICAL to
 * the full sessionHook implementation (the two legs of the vendored two-leg
 * require must be interchangeable), and the shared cache format round-trips.
 *
 * Run: node --test factories/runtime/__tests__/envconfig-lite.spec.js
 */

'use strict';

const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lite = require('../envconfig-lite');
const sessionHook = require('../../envConfig/sessionHook');
const { schemaHash: fullSchemaHash } = require('../../envConfig/schema');
const { resetRuntimeCache } = require('../index');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'envconfig-lite-'));
after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const SCHEMA = {
  plugin: 'litetest',
  prefixes: ['LITETEST_'],
  vars: {
    LITETEST_FOO: { type: 'string', description: 'first var', section: 'General' },
    LITETEST_BAR: { type: 'bool01', description: 'second var', section: 'General' },
    LITETEST_DEEP: {
      type: 'string',
      description: 'advanced var',
      section: 'Advanced',
      advanced: true,
    },
  },
};

let seq = 0;
function makePluginRoot(schema = SCHEMA) {
  const root = path.join(TMP, `plugin-${seq++}`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config-schema.json'), `${JSON.stringify(schema, null, 2)}\n`);
  return root;
}

function cachePath() {
  return path.join(TMP, `cache-${seq++}.json`);
}

beforeEach(() => resetRuntimeCache());

describe('parity with factories/envConfig', () => {
  it('drift nudge output is byte-identical to sessionHook.run', () => {
    const pluginRoot = makePluginRoot();
    const cwd = TMP; // not a git repo → both legs fall back to resolved cwd
    const args = { pluginRoot, configureCommand: '/work-workflow:configure', cwd };
    const liteOut = lite.run({ ...args, cachePath: cachePath() });
    const fullOut = sessionHook.run({ ...args, cachePath: cachePath() });
    assert.ok(liteOut.includes('unconfigured config var(s)'), `unexpected output: ${liteOut}`);
    assert.equal(liteOut, fullOut);
  });

  it('schemaHash matches the full implementation (shared cache compatibility)', () => {
    assert.equal(lite.schemaHash(SCHEMA), fullSchemaHash(SCHEMA));
  });

  it('cache written by the full leg silences the lite leg (and vice versa)', () => {
    const pluginRoot = makePluginRoot();
    const shared = cachePath();
    const projectRoot = lite.projectKey(TMP);
    lite.markConfigured({
      cachePath: shared,
      projectRoot,
      plugin: 'litetest',
      hash: lite.schemaHash(SCHEMA),
      acknowledgedVars: ['LITETEST_FOO', 'LITETEST_BAR'],
    });
    const out = lite.run({
      pluginRoot,
      configureCommand: '/work-workflow:configure',
      cachePath: shared,
      cwd: TMP,
    });
    assert.equal(out, '');
  });
});

describe('detect', () => {
  it('flags missing non-advanced vars on first run', () => {
    const result = lite.detect({
      schema: SCHEMA,
      cachePath: cachePath(),
      projectRoot: '/proj',
      values: { LITETEST_BAR: { value: '1' } },
    });
    assert.equal(result.changed, true);
    assert.equal(result.firstRun, true);
    assert.deepEqual(result.missing, ['LITETEST_FOO']); // advanced never nags
  });

  it('acknowledged vars stop nagging; matching hash is the silent fast path', () => {
    const cache = cachePath();
    lite.markConfigured({
      cachePath: cache,
      projectRoot: '/proj',
      plugin: 'litetest',
      hash: 'other-hash',
      acknowledgedVars: ['LITETEST_FOO'],
    });
    const drifted = lite.detect({
      schema: SCHEMA,
      cachePath: cache,
      projectRoot: '/proj',
      values: {},
    });
    assert.deepEqual(drifted.missing, ['LITETEST_BAR']);

    lite.markConfigured({
      cachePath: cache,
      projectRoot: '/proj',
      plugin: 'litetest',
      hash: lite.schemaHash(SCHEMA),
    });
    const silent = lite.detect({
      schema: SCHEMA,
      cachePath: cache,
      projectRoot: '/proj',
      values: {},
    });
    assert.equal(silent.changed, false);
  });
});

describe('run', () => {
  it('returns "" and self-acknowledges when nothing is missing', () => {
    const pluginRoot = makePluginRoot();
    const cache = cachePath();
    process.env.LITETEST_FOO = 'x';
    process.env.LITETEST_BAR = '1';
    try {
      const out = lite.run({
        pluginRoot,
        configureCommand: '/work-workflow:configure',
        cachePath: cache,
        cwd: TMP,
      });
      assert.equal(out, '');
      const stored = JSON.parse(fs.readFileSync(cache, 'utf8'));
      assert.ok(stored.projects[lite.projectKey(TMP)].litetest.schemaHash);
    } finally {
      delete process.env.LITETEST_FOO;
      delete process.env.LITETEST_BAR;
    }
  });

  it('fails open on a broken schema', () => {
    const root = path.join(TMP, 'broken-plugin');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'config-schema.json'), '{not json');
    assert.equal(
      lite.run({ pluginRoot: root, configureCommand: '/x:y', cachePath: cachePath(), cwd: TMP }),
      ''
    );
    assert.equal(
      lite.run({
        pluginRoot: path.join(TMP, 'absent'),
        configureCommand: '/x:y',
        cachePath: cachePath(),
        cwd: TMP,
      }),
      ''
    );
  });

  it('renders the configure command per runtime (C13) — claude byte-identical', () => {
    const pluginRoot = makePluginRoot();
    process.env.AGENT_RUNTIME = 'codex';
    try {
      resetRuntimeCache();
      const out = lite.run({
        pluginRoot,
        configureCommand: '/work-workflow:configure',
        cachePath: cachePath(),
        cwd: TMP,
      });
      assert.ok(out.includes('the $configure skill (work-workflow:configure)'), out);
    } finally {
      delete process.env.AGENT_RUNTIME;
      resetRuntimeCache();
    }
  });
});

describe('entrypoint helpers', () => {
  it('loadSchemaLite is tolerant: valid → schema, invalid shape/JSON → null', () => {
    const root = makePluginRoot();
    assert.equal(lite.loadSchemaLite(path.join(root, 'config-schema.json')).plugin, 'litetest');
    const bad = path.join(TMP, 'bad-schema.json');
    fs.writeFileSync(bad, JSON.stringify({ vars: {} })); // no plugin name
    assert.equal(lite.loadSchemaLite(bad), null);
    assert.equal(lite.loadSchemaLite(path.join(TMP, 'absent.json')), null);
  });

  it('resolveHookCwd prefers CLAUDE_PROJECT_DIR', () => {
    process.env.CLAUDE_PROJECT_DIR = '/proj/dir';
    try {
      assert.equal(lite.resolveHookCwd(), '/proj/dir');
    } finally {
      delete process.env.CLAUDE_PROJECT_DIR;
    }
  });

  it('tryMain prints the nudge and exits 0 (spawned, hook-style)', () => {
    const { spawnSync } = require('node:child_process');
    const pluginRoot = makePluginRoot();
    const hooksDir = path.join(pluginRoot, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const script = `require(${JSON.stringify(require.resolve('../envconfig-lite'))}).tryMain(${JSON.stringify(hooksDir)}, '/work-workflow:configure');`;
    const res = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      cwd: TMP,
      input: JSON.stringify({ cwd: TMP }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: '', HOME: path.join(TMP, 'spawn-home') },
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /litetest: 2 unconfigured config var\(s\)/);
    assert.match(res.stdout, /Run \/work-workflow:configure to set them up/);
  });
});

describe('readValuesLite', () => {
  it('layers env files under process env (static parse, quotes stripped)', () => {
    const home = path.join(TMP, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', '.env'),
      'LITETEST_GLOBAL=from-global\nLITETEST_LAYER=global\n'
    );
    const cwd = path.join(TMP, 'proj', 'nested');
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(TMP, 'proj', '.envrc'),
      'export LITETEST_LAYER="envrc"\n# comment\nnot a var line\n'
    );
    const values = lite.readValuesLite({ cwd, home, env: { LITETEST_PROC: 'proc' } });
    assert.equal(values.LITETEST_GLOBAL.value, 'from-global');
    assert.equal(values.LITETEST_LAYER.value, 'envrc');
    assert.equal(values.LITETEST_PROC.value, 'proc');
  });
});
