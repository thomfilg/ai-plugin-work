'use strict';

// End-to-end migration of work-workflow's per-user state via the real
// SessionStart hook.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', '..', '..', '..', 'hooks', 'store-migrate.js');
const migrations = require(path.resolve(__dirname, '..', 'store-migrations'));

const HOME_DRIVEN = process.platform !== 'win32';

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

function legacyState() {
  const dir = path.join(home, '.claude', 'work-workflow');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.reminders'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'inbox-cursors.json'), '{"GH-1":7}');
  fs.writeFileSync(path.join(dir, 'logs', 'next-scripts.jsonl'), '{"ev":1}\n');
  fs.writeFileSync(path.join(dir, '.reminders', 'sess.json'), '{"reminders":{}}');
  return dir;
}

beforeEach(() => {
  originalHome = process.env.HOME;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'work-mig-'));
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

describe('work-workflow migration declaration', () => {
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

  it('the declared roots match storeDiscovery', () => {
    // Spelled out locally because work has no marker-gated store; if the
    // factory ever renames a root this must be updated in lockstep.
    const { createStoreDiscovery } = require(
      path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'factories', 'storeDiscovery')
    );
    const api = createStoreDiscovery({
      folder: 'x',
      marker: '.x.json',
      projectNameStrategy: 'toplevel',
    });
    assert.equal(migrations.ROOT_DIR, api.ROOT_DIR);
    assert.equal(migrations.LEGACY_ROOT_DIR, api.LEGACY_ROOT_DIR);
  });
});

describe('SessionStart migrates per-user state', { skip: !HOME_DRIVEN }, () => {
  it('relocates reminders, logs and inbox cursors', () => {
    const legacy = legacyState();
    const res = runMigrateHook(repo);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.equal(res.stderr, '', 'migration must stay silent on stderr');
    assert.equal(fs.existsSync(legacy), false);

    const target = path.join(home, '.workflow', 'work-workflow');
    // The cursors are the one that bites — losing them re-injects old
    // monitor messages into a fresh session.
    assert.equal(
      fs.readFileSync(path.join(target, 'state', 'inbox-cursors.json'), 'utf8'),
      '{"GH-1":7}'
    );
    assert.equal(fs.existsSync(path.join(target, 'logs', 'next-scripts.jsonl')), true);
    assert.equal(fs.existsSync(path.join(target, '.reminders', 'sess.json')), true);
  });

  it('the inbox-cursor reader sees the migrated cursors', () => {
    legacyState();
    runMigrateHook(repo);
    const cursorFile = path.join(home, '.workflow', 'work-workflow', 'state', 'inbox-cursors.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(cursorFile, 'utf8')), { 'GH-1': 7 });
  });

  it('stamps the state dir so a second session is a no-op', () => {
    legacyState();
    runMigrateHook(repo);
    const target = path.join(home, '.workflow', 'work-workflow');
    assert.equal(migrations.readVersion(target), migrations.LATEST_VERSION);
    const before = fs.readFileSync(path.join(target, '.version.json'), 'utf8');
    runMigrateHook(repo);
    assert.equal(fs.readFileSync(path.join(target, '.version.json'), 'utf8'), before);
  });

  it('does nothing when there is no legacy state', () => {
    const res = runMigrateHook(repo);
    assert.equal(res.status, 0);
    assert.equal(fs.existsSync(path.join(home, '.workflow', 'work-workflow')), false);
  });
});
