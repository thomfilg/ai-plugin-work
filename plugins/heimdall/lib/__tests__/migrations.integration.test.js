'use strict';

// End-to-end migration of a pre-.workflow heimdall install: the legacy lock
// store AND the conceal config are seeded under `.claude/`, the SessionStart
// hook is spawned, and both must land under `.workflow/`.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'store-migrate.js');
const CONCEAL_HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'heimdall-conceal.js');
const migrations = require(path.resolve(__dirname, '..', 'store-migrations'));
const { discoverStores } = require(path.resolve(__dirname, '..', 'lock-store'));

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

beforeEach(() => {
  originalHome = process.env.HOME;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'heim-mig-'));
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

describe('heimdall migration declaration', () => {
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

describe('SessionStart migrates the lock store', { skip: !HOME_DRIVEN }, () => {
  it('relocates .claude/heimdall and keeps the locks discoverable', () => {
    const legacy = path.join(repo, '.claude', 'heimdall');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(
      path.join(legacy, '.heimdall.json'),
      JSON.stringify({ kind: 'local', locks: [{ protect: ['secrets'], unlockPhrase: 'open up' }] })
    );

    const res = runMigrateHook(repo);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.equal(res.stderr, '', 'migration must stay silent on stderr');
    assert.equal(fs.existsSync(legacy), false);

    const stores = discoverStores(repo);
    const local = stores.find((s) => s.kind === 'local');
    assert.ok(local, 'migrated store must be discoverable');
    assert.equal(local.dir, path.join(repo, '.workflow', 'heimdall'));
  });
});

describe('SessionStart migrates the conceal config', { skip: !HOME_DRIVEN }, () => {
  const POLICY = JSON.stringify({
    denyFilePatterns: ['secret-vault\\.txt'],
    denyCommandPatterns: ['secret-vault\\.txt'],
  });

  it('carries the conceal config even when NO lock store exists', () => {
    // The guard is safe-by-default-OFF, so a stranded config does not fail
    // loudly — it silently stops concealing. This is the case that matters.
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'heimdall-conceal.json'), POLICY);

    runMigrateHook(repo);

    assert.equal(
      fs.readFileSync(path.join(repo, '.workflow', 'heimdall-conceal.json'), 'utf8'),
      POLICY
    );
    assert.equal(fs.existsSync(path.join(repo, '.claude', 'heimdall-conceal.json')), false);
  });

  it('the guard actually denies again after the migration', () => {
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'heimdall-conceal.json'), POLICY);
    fs.writeFileSync(path.join(repo, 'secret-vault.txt'), 'TOP SECRET\n');

    const guard = (cwd) =>
      spawnSync(process.execPath, [CONCEAL_HOOK], {
        input: JSON.stringify({
          cwd,
          tool_name: 'Read',
          tool_input: { file_path: path.join(cwd, 'secret-vault.txt') },
        }),
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: cwd },
      }).status;

    // Pre-migration the config is invisible to the guard → silently allowed.
    assert.equal(guard(repo), 0, 'precondition: stranded config means no concealment');
    runMigrateHook(repo);
    assert.equal(guard(repo), 2, 'concealment restored after migration');
  });

  it('carries the block log alongside the config', () => {
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'heimdall-conceal.json'), POLICY);
    fs.writeFileSync(path.join(repo, '.claude', 'heimdall-conceal.log'), '{"blocked":1}\n');

    runMigrateHook(repo);

    assert.equal(
      fs.readFileSync(path.join(repo, '.workflow', 'heimdall-conceal.log'), 'utf8'),
      '{"blocked":1}\n'
    );
  });

  it('does nothing when there is no legacy state at all', () => {
    const res = runMigrateHook(repo);
    assert.equal(res.status, 0);
    assert.equal(fs.existsSync(path.join(repo, '.workflow')), false);
  });
});
