'use strict';

// End-to-end migration of a real pre-.workflow synapsys install: the legacy
// store is seeded under `.claude/`, the SessionStart hook is spawned, and the
// memories must be discoverable at the new path afterwards.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'synapsys.js');
const migrations = require(path.resolve(__dirname, '..', 'store-migrations'));
const { discoverStores, listMemoriesFromStore } = require(
  path.resolve(__dirname, '..', 'memory-store')
);

const HOME_DRIVEN = process.platform !== 'win32';

const MEMORY = [
  '---',
  'name: legacy-memory',
  'description: seeded into the pre-.workflow store',
  'events: UserPromptSubmit',
  'trigger_prompt: \\bzebra\\b',
  'inject: full',
  '---',
  'Body of the legacy memory.',
].join('\n');

let base;
let home;
let repo;
let originalHome;

function seedLegacyStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.synapsys.json'), JSON.stringify({ kind: 'local' }));
  fs.writeFileSync(path.join(dir, 'legacy-memory.md'), MEMORY);
  return dir;
}

function runSessionStart(cwd) {
  return spawnSync(process.execPath, [HOOK, 'SessionStart'], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, SYNAPSYS_TELEMETRY: '0' },
    cwd,
  });
}

beforeEach(() => {
  originalHome = process.env.HOME;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-mig-'));
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

describe('synapsys migration declaration', () => {
  const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

  it('discovers one file per migration, ascending and unique', () => {
    const versions = migrations.MIGRATIONS.map((m) => m.version);
    assert.ok(versions.length > 0, 'at least one migration must be discovered');
    assert.deepEqual(
      versions,
      [...versions].sort((a, b) => a - b),
      'must be ascending'
    );
    assert.equal(new Set(versions).size, versions.length, 'must be unique');
    assert.equal(migrations.LATEST_VERSION, Math.max(...versions));
  });

  it('every migration file on disk is discovered — none silently skipped', () => {
    const onDisk = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.js'))
      .sort();
    assert.equal(
      migrations.MIGRATIONS.length,
      onDisk.length,
      `discovered ${migrations.MIGRATIONS.length} of ${onDisk.length} files: ${onDisk.join(', ')}`
    );
  });

  it('every version matches its filename timestamp', () => {
    const fromNames = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.js'))
      .map((f) => Number(f.slice(0, 14)))
      .sort((a, b) => a - b);
    assert.deepEqual(
      migrations.MIGRATIONS.map((m) => m.version),
      fromNames
    );
  });

  it('every migration carries a description', () => {
    for (const m of migrations.MIGRATIONS) {
      assert.ok(m.description && m.description.length > 0, `v${m.version} needs a description`);
    }
  });
});

describe('SessionStart migrates a legacy local store', { skip: !HOME_DRIVEN }, () => {
  it('relocates .claude/synapsys to .workflow/synapsys and keeps the memories readable', () => {
    const legacy = seedLegacyStore(path.join(repo, '.claude', 'synapsys'));
    const target = path.join(repo, '.workflow', 'synapsys');

    const res = runSessionStart(repo);
    assert.equal(res.status, 0, `hook must exit 0; stderr=${res.stderr}`);
    assert.equal(res.stderr, '', 'migration must stay silent on stderr');

    assert.equal(fs.existsSync(legacy), false, 'legacy store is gone after the move');
    assert.equal(fs.existsSync(path.join(target, 'legacy-memory.md')), true);

    const stores = discoverStores(repo);
    const local = stores.find((s) => s.kind === 'local');
    assert.ok(local, 'migrated store must be discoverable');
    const names = listMemoriesFromStore(local).map((m) => m.name);
    assert.deepEqual(names, ['legacy-memory']);
  });

  it('stamps the migrated store so a second session is a no-op', () => {
    seedLegacyStore(path.join(repo, '.claude', 'synapsys'));
    runSessionStart(repo);
    const target = path.join(repo, '.workflow', 'synapsys');
    assert.equal(migrations.readVersion(target), migrations.LATEST_VERSION);

    const before = fs.readFileSync(path.join(target, '.version.json'), 'utf8');
    runSessionStart(repo);
    assert.equal(fs.readFileSync(path.join(target, '.version.json'), 'utf8'), before);
  });

  it('merges into an existing new-path store without clobbering it', () => {
    seedLegacyStore(path.join(repo, '.claude', 'synapsys'));
    // User reinstalled before upgrading: an empty store already sits at the
    // new path while the real memories are still at the old one.
    const target = path.join(repo, '.workflow', 'synapsys');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '.synapsys.json'), JSON.stringify({ kind: 'local' }));

    runSessionStart(repo);

    assert.equal(fs.existsSync(path.join(target, 'legacy-memory.md')), true, 'data recovered');
    assert.equal(
      fs.existsSync(path.join(repo, '.claude', 'synapsys')),
      true,
      'source kept as backup'
    );
  });

  it('migrates a worktree store discovered from a deeply-nested cwd', () => {
    // Pre-migration, discovery finds `<wt>/.claude/synapsys` from `<wt>/a/b`
    // via its ancestor walk. The migration must reach the same store, or the
    // memories become invisible the moment discovery stops looking at .claude.
    const legacy = seedLegacyStore(path.join(repo, '.claude', 'synapsys'));
    const deep = path.join(repo, 'packages', 'app');
    fs.mkdirSync(deep, { recursive: true });

    runSessionStart(deep);

    assert.equal(fs.existsSync(legacy), false, 'walked store must be migrated');
    const target = path.join(repo, '.workflow', 'synapsys');
    assert.equal(fs.existsSync(path.join(target, 'legacy-memory.md')), true);

    const wt = discoverStores(deep).find((s) => s.kind === 'worktree');
    assert.ok(wt, 'migrated store must still be discoverable from the nested cwd');
    assert.deepEqual(
      listMemoriesFromStore(wt).map((m) => m.name),
      ['legacy-memory']
    );
  });

  it('does nothing at all when there is no legacy store', () => {
    const res = runSessionStart(repo);
    assert.equal(res.status, 0);
    assert.equal(fs.existsSync(path.join(repo, '.workflow')), false, 'must not create a store');
  });
});

describe('SessionStart migrates the home namespace', { skip: !HOME_DRIVEN }, () => {
  it('carries loose per-user state across, not just the per-project store', () => {
    const legacyHome = path.join(home, '.claude', 'synapsys');
    fs.mkdirSync(path.join(legacyHome, '.telemetry'), { recursive: true });
    fs.mkdirSync(path.join(legacyHome, 'someproject'), { recursive: true });
    fs.writeFileSync(path.join(legacyHome, 'DOMAINS.md'), '# domains\n');
    fs.writeFileSync(path.join(legacyHome, '.telemetry', 'events.jsonl'), '{}\n');
    fs.writeFileSync(
      path.join(legacyHome, 'someproject', '.synapsys.json'),
      JSON.stringify({ kind: 'global' })
    );

    runSessionStart(repo);

    const newHome = path.join(home, '.workflow', 'synapsys');
    assert.equal(fs.readFileSync(path.join(newHome, 'DOMAINS.md'), 'utf8'), '# domains\n');
    assert.equal(fs.existsSync(path.join(newHome, '.telemetry', 'events.jsonl')), true);
    assert.equal(
      fs.existsSync(path.join(newHome, 'someproject', '.synapsys.json')),
      true,
      'per-project global stores ride along inside the namespace'
    );
  });

  it('migrates the cross-project shared store', () => {
    const legacyShared = path.join(home, '.claude', 'synapsys-shared');
    fs.mkdirSync(legacyShared, { recursive: true });
    fs.writeFileSync(path.join(legacyShared, '.synapsys.json'), JSON.stringify({ kind: 'shared' }));
    fs.writeFileSync(path.join(legacyShared, 'shared-memory.md'), MEMORY);

    runSessionStart(repo);

    const newShared = path.join(home, '.workflow', 'synapsys-shared');
    assert.equal(fs.existsSync(path.join(newShared, 'shared-memory.md')), true);
    assert.equal(fs.existsSync(legacyShared), false);
  });
});
