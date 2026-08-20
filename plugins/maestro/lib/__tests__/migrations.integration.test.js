'use strict';

// End-to-end migration of a pre-.workflow maestro install: a saved schema
// under `.claude/maestro/` must be reachable by name afterwards.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'store-migrate.js');
const migrations = require(path.resolve(__dirname, '..', 'store-migrations'));
const { discoverStores, findSchemaTiers } = require(path.resolve(__dirname, '..', 'schema-store'));

const HOME_DRIVEN = process.platform !== 'win32';

const SCHEMA = ['---', 'name: opera1', 'poolSize: 1', 'command: /qc-work', '---', ''].join('\n');

let base;
let home;
let repo;
let originalHome;

function runMigrateHook(cwd) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    cwd,
  });
}

beforeEach(() => {
  originalHome = process.env.HOME;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mig-'));
  home = path.join(base, 'home');
  repo = path.join(base, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(base, { recursive: true, force: true });
});

describe('maestro migration declaration', () => {
  it('discovers one file per migration, ascending and unique', () => {
    const versions = migrations.MIGRATIONS.map((m) => m.version);
    assert.ok(versions.length > 0);
    assert.deepEqual(
      versions,
      [...versions].sort((a, b) => a - b)
    );
    assert.equal(new Set(versions).size, versions.length);
    assert.equal(migrations.LATEST_VERSION, Math.max(...versions));
  });

  it('every migration file on disk is discovered', () => {
    const onDisk = fs
      .readdirSync(path.resolve(__dirname, '..', 'migrations'))
      .filter((f) => f.endsWith('.js'));
    assert.equal(migrations.MIGRATIONS.length, onDisk.length);
  });
});

describe('SessionStart migrates the schema store', { skip: !HOME_DRIVEN }, () => {
  it('relocates .claude/maestro so a saved schema resolves by name again', () => {
    const legacy = path.join(repo, '.claude', 'maestro');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, '.maestro.json'), JSON.stringify({ kind: 'local' }));
    fs.writeFileSync(path.join(legacy, 'opera1.md'), SCHEMA);

    const res = runMigrateHook(repo);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.equal(res.stderr, '', 'migration must stay silent on stderr');
    assert.equal(fs.existsSync(legacy), false);

    const local = discoverStores(repo).find((s) => s.kind === 'local');
    assert.ok(local, 'migrated store must be discoverable');
    assert.equal(local.dir, path.join(repo, '.workflow', 'maestro'));
    assert.equal(findSchemaTiers(repo, 'opera1').length, 1, 'schema resolves by name');
  });

  it('stamps the store so a second session is a no-op', () => {
    const legacy = path.join(repo, '.claude', 'maestro');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, '.maestro.json'), JSON.stringify({ kind: 'local' }));
    runMigrateHook(repo);

    const target = path.join(repo, '.workflow', 'maestro');
    assert.equal(migrations.readVersion(target), migrations.LATEST_VERSION);
    const before = fs.readFileSync(path.join(target, '.version.json'), 'utf8');
    runMigrateHook(repo);
    assert.equal(fs.readFileSync(path.join(target, '.version.json'), 'utf8'), before);
  });

  it('does nothing when there is no legacy store', () => {
    const res = runMigrateHook(repo);
    assert.equal(res.status, 0);
    assert.equal(fs.existsSync(path.join(repo, '.workflow')), false);
  });
});
