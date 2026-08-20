'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createStoreMigrator,
  relocateDirectory,
  relocateFile,
  relocatePath,
  relocateStore,
} = require('../index');

let base;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-'));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function seed(dir, files = { 'a.md': 'A' }) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

function readStamp(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.version.json'), 'utf8'));
}

/** Migrator over a single location, with a recording migration per version. */
function makeMigrator(location, versions, overrides = {}) {
  const calls = [];
  const migrations = versions.map((v) => ({
    version: v,
    description: `m${v}`,
    migrate: (ctx) => {
      calls.push(v);
      if (overrides.body) overrides.body(v, ctx);
    },
  }));
  const migrator = createStoreMigrator({
    plugin: 'acme',
    migrations,
    locations: () => [location],
    ...(overrides.config || {}),
  });
  return { migrator, calls };
}

describe('config validation', () => {
  const valid = { plugin: 'acme', locations: () => [], migrations: [{ version: 1, migrate() {} }] };

  it('rejects a non-object config', () => {
    assert.throws(() => createStoreMigrator(null), /config object required/);
  });

  it('requires plugin, locations and a non-empty migrations array', () => {
    assert.throws(() => createStoreMigrator({ ...valid, plugin: '' }), /"plugin"/);
    assert.throws(() => createStoreMigrator({ ...valid, locations: 'x' }), /"locations"/);
    assert.throws(
      () => createStoreMigrator({ ...valid, migrations: [] }),
      /no migrations declared/
    );
    const { migrations: _drop, ...noList } = valid;
    assert.throws(() => createStoreMigrator(noList), /"migrationsDir" or "migrations" required/);
    assert.throws(() => createStoreMigrator({ ...valid, migrationsDir: '/tmp/x' }), /not both/);
  });

  it('rejects bad migration entries', () => {
    const bad = (migrations) => () => createStoreMigrator({ ...valid, migrations });
    assert.throws(bad([{ version: 0, migrate() {} }]), /positive integer/);
    assert.throws(bad([{ version: 1.5, migrate() {} }]), /positive integer/);
    assert.throws(bad([{ version: 1 }]), /"migrate" function/);
    assert.throws(
      bad([
        { version: 1, migrate() {} },
        { version: 1, migrate() {} },
      ]),
      /duplicate/
    );
  });

  it('derives LATEST_VERSION from the highest version regardless of input order', () => {
    const m = createStoreMigrator({
      ...valid,
      migrations: [
        { version: 5, migrate() {} },
        { version: 2, migrate() {} },
      ],
    });
    assert.equal(m.LATEST_VERSION, 5);
    assert.deepEqual(m.pending(2), [5]);
    assert.deepEqual(m.pending(0), [2, 5]);
  });
});

describe('baseline resolution', () => {
  it('an absent dir with no legacy dir is left completely alone', () => {
    const dir = path.join(base, 'store');
    const { migrator, calls } = makeMigrator({ dir }, [1]);
    const res = migrator.run({ cwd: base });
    assert.deepEqual(calls, []);
    assert.deepEqual(res.migrated, []);
    assert.equal(fs.existsSync(dir), false, 'run must never create an uninstalled store');
  });

  it('an existing dir with no stamp is version 0 and gets every migration', () => {
    const dir = seed(path.join(base, 'store'));
    const { migrator, calls } = makeMigrator({ dir }, [1, 2]);
    migrator.run({ cwd: base });
    assert.deepEqual(calls, [1, 2]);
    assert.equal(readStamp(dir).version, 2);
  });

  it('a stamped dir only gets migrations above its version', () => {
    const dir = seed(path.join(base, 'store'));
    fs.writeFileSync(path.join(dir, '.version.json'), JSON.stringify({ version: 1 }));
    const { migrator, calls } = makeMigrator({ dir }, [1, 2, 3]);
    migrator.run({ cwd: base });
    assert.deepEqual(calls, [2, 3]);
  });

  it('a corrupt stamp is treated as version 0, not as up-to-date', () => {
    const dir = seed(path.join(base, 'store'));
    fs.writeFileSync(path.join(dir, '.version.json'), '{ not json');
    const { migrator, calls } = makeMigrator({ dir }, [1]);
    migrator.run({ cwd: base });
    assert.deepEqual(calls, [1]);
  });

  it('an absent dir whose legacy dir exists is version 0', () => {
    const legacyDir = seed(path.join(base, 'old'));
    const dir = path.join(base, 'new');
    const { migrator, calls } = makeMigrator({ dir, legacyDir }, [1], {
      body: (_v, ctx) => relocateDirectory(ctx.legacyDir, ctx.dir),
    });
    migrator.run({ cwd: base });
    assert.deepEqual(calls, [1]);
    assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'A');
  });

  it('is idempotent — a second run does nothing', () => {
    const dir = seed(path.join(base, 'store'));
    const { migrator, calls } = makeMigrator({ dir }, [1, 2]);
    migrator.run({ cwd: base });
    migrator.run({ cwd: base });
    assert.deepEqual(calls, [1, 2]);
  });
});

describe('failure handling', () => {
  it('a throwing migration stops that chain, keeps the last good stamp, and is reported', () => {
    const dir = seed(path.join(base, 'store'));
    const migrator = createStoreMigrator({
      plugin: 'acme',
      locations: () => [{ dir }],
      migrations: [
        { version: 1, migrate() {} },
        {
          version: 2,
          migrate() {
            throw new Error('boom');
          },
        },
        { version: 3, migrate() {} },
      ],
    });
    const res = migrator.run({ cwd: base });
    assert.equal(readStamp(dir).version, 1, 'stamp stays at the last migration that succeeded');
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0].error.message, /boom/);
    assert.deepEqual(res.migrated[0].applied, [1]);
  });

  it('one failing location does not stop the others', () => {
    const bad = seed(path.join(base, 'bad'));
    const good = seed(path.join(base, 'good'));
    const migrator = createStoreMigrator({
      plugin: 'acme',
      locations: () => [{ dir: bad }, { dir: good }],
      migrations: [
        {
          version: 1,
          migrate(ctx) {
            if (ctx.dir === bad) throw new Error('nope');
          },
        },
      ],
    });
    const res = migrator.run({ cwd: base });
    assert.equal(res.errors.length, 1);
    assert.equal(readStamp(good).version, 1);
  });

  it('a failed stamp stops the chain and is reported, not silently swallowed', () => {
    // The transformation happened but the record of it did not. Continuing
    // would stack the next migration on a store still recorded as pre-N.
    const dir = seed(path.join(base, 'store'));
    const calls = [];
    const migrator = createStoreMigrator({
      plugin: 'acme',
      versionFile: 'ro/.version.json', // parent is a FILE → the write must fail
      locations: () => [{ dir }],
      migrations: [
        { version: 1, migrate: () => calls.push(1) },
        { version: 2, migrate: () => calls.push(2) },
      ],
    });
    fs.writeFileSync(path.join(dir, 'ro'), 'not a directory');

    const res = migrator.run({ cwd: base });
    assert.deepEqual(calls, [1], 'must not run migration 2 on an unstamped store');
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0].error.message, /could not write/);
    assert.match(res.errors[0].error.message, /replayed next run/);
  });

  it('a throwing locations() is captured, not propagated', () => {
    const migrator = createStoreMigrator({
      plugin: 'acme',
      locations: () => {
        throw new Error('bad cwd');
      },
      migrations: [{ version: 1, migrate() {} }],
    });
    const res = migrator.run({ cwd: base });
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0].error.message, /bad cwd/);
  });

  it('skips malformed location rows', () => {
    const dir = seed(path.join(base, 'store'));
    const migrator = createStoreMigrator({
      plugin: 'acme',
      locations: () => [null, { dir: '' }, 'nope', { dir }],
      migrations: [{ version: 1, migrate() {} }],
    });
    const res = migrator.run({ cwd: base });
    assert.equal(res.errors.length, 0);
    assert.equal(readStamp(dir).version, 1);
  });
});

describe('locking', () => {
  it('skips a location another process is migrating', () => {
    const dir = seed(path.join(base, 'store'));
    fs.mkdirSync(path.join(base, '.store.migrating'));
    const { migrator, calls } = makeMigrator({ dir }, [1]);
    const res = migrator.run({ cwd: base });
    assert.deepEqual(calls, [], 'must not migrate under a live lock');
    assert.deepEqual(res.locked, [dir]);
  });

  it('steals a lock older than lockTimeoutMs', () => {
    const dir = seed(path.join(base, 'store'));
    const lock = path.join(base, '.store.migrating');
    fs.mkdirSync(lock);
    const old = Date.now() - 60_000;
    fs.utimesSync(lock, new Date(old), new Date(old));
    const { migrator, calls } = makeMigrator({ dir }, [1], {
      config: { lockTimeoutMs: 1_000 },
    });
    migrator.run({ cwd: base });
    assert.deepEqual(calls, [1]);
  });

  it('releases the lock even when a migration throws', () => {
    const dir = seed(path.join(base, 'store'));
    const migrator = createStoreMigrator({
      plugin: 'acme',
      locations: () => [{ dir }],
      migrations: [
        {
          version: 1,
          migrate() {
            throw new Error('boom');
          },
        },
      ],
    });
    migrator.run({ cwd: base });
    assert.equal(fs.existsSync(path.join(base, '.store.migrating')), false);
  });

  it('acquires a lock even when the store parent does not exist yet', () => {
    // Regression: the first migration of a relocated store runs before the new
    // root exists, so mkdir(lock) fails ENOENT. Reporting that as "another
    // process holds it" silently skips the one migration that matters.
    const legacyDir = seed(path.join(base, 'old'));
    const dir = path.join(base, 'brand', 'new', 'store');
    const { migrator, calls } = makeMigrator({ dir, legacyDir }, [1], {
      body: (_v, ctx) => relocateDirectory(ctx.legacyDir, ctx.dir),
    });
    const res = migrator.run({ cwd: base });
    assert.deepEqual(res.locked, [], 'a missing parent is not a held lock');
    assert.deepEqual(calls, [1]);
    assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'A');
  });

  it('places the lock beside the store, so a relocation cannot carry it away', () => {
    const legacyDir = seed(path.join(base, 'old'));
    const dir = path.join(base, 'new');
    const { migrator } = makeMigrator({ dir, legacyDir }, [1], {
      body: (_v, ctx) => relocateDirectory(ctx.legacyDir, ctx.dir),
    });
    migrator.run({ cwd: base });
    assert.equal(fs.existsSync(path.join(dir, '.new.migrating')), false);
    assert.equal(fs.existsSync(path.join(base, '.new.migrating')), false);
  });
});

describe('stamp contents', () => {
  it('records the plugin, the version and an ISO timestamp', () => {
    const dir = seed(path.join(base, 'store'));
    const migrator = createStoreMigrator({
      plugin: 'acme',
      locations: () => [{ dir }],
      migrations: [{ version: 7, migrate() {} }],
      now: () => Date.parse('2026-01-02T03:04:05.000Z'),
    });
    migrator.run({ cwd: base });
    assert.deepEqual(readStamp(dir), {
      plugin: 'acme',
      version: 7,
      updatedAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('stampLatest marks a fresh store as fully migrated', () => {
    const dir = seed(path.join(base, 'store'));
    const { migrator, calls } = makeMigrator({ dir }, [1, 2]);
    migrator.stampLatest(dir);
    migrator.run({ cwd: base });
    assert.deepEqual(calls, [], 'a freshly stamped store has nothing pending');
    assert.equal(migrator.readVersion(dir), 2);
  });

  it('readVersion reports null for an absent dir', () => {
    const { migrator } = makeMigrator({ dir: path.join(base, 'nope') }, [1]);
    assert.equal(migrator.readVersion(path.join(base, 'nope')), null);
  });
});

describe('legacyPaths (data kept outside the store)', () => {
  it('makes a location live when only a legacy out-of-store file exists', () => {
    // Without this the location reads as "not installed" and the file is
    // stranded — which for a security config means it silently stops applying.
    const dir = path.join(base, 'root', 'plug');
    const legacyFile = path.join(base, 'old', 'plug-config.json');
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, '{"deny":["x"]}');

    const migrator = createStoreMigrator({
      plugin: 'acme',
      locations: () => [
        { dir, legacyDir: path.join(base, 'old', 'plug'), legacyPaths: [legacyFile] },
      ],
      migrations: [{ version: 1, migrate: relocateStore() }],
    });
    migrator.run({ cwd: base });

    const moved = path.join(base, 'root', 'plug-config.json');
    assert.equal(fs.readFileSync(moved, 'utf8'), '{"deny":["x"]}', 'config lands beside the store');
    assert.equal(fs.existsSync(legacyFile), false);
  });

  it('stays a no-op when neither the store nor any legacy path exists', () => {
    const dir = path.join(base, 'root', 'plug');
    const migrator = createStoreMigrator({
      plugin: 'acme',
      locations: () => [
        { dir, legacyDir: path.join(base, 'old', 'plug'), legacyPaths: [path.join(base, 'nope')] },
      ],
      migrations: [{ version: 1, migrate: relocateStore() }],
    });
    const res = migrator.run({ cwd: base });
    assert.deepEqual(res.migrated, []);
    assert.equal(fs.existsSync(path.join(base, 'root')), false);
  });

  it('carries the store AND its sidecar config in one migration', () => {
    const legacyDir = seed(path.join(base, 'old', 'plug'));
    const legacyFile = path.join(base, 'old', 'plug-config.json');
    fs.writeFileSync(legacyFile, 'cfg');
    const dir = path.join(base, 'root', 'plug');

    createStoreMigrator({
      plugin: 'acme',
      locations: () => [{ dir, legacyDir, legacyPaths: [legacyFile] }],
      migrations: [{ version: 1, migrate: relocateStore() }],
    }).run({ cwd: base });

    assert.equal(fs.existsSync(path.join(dir, 'a.md')), true, 'store moved');
    assert.equal(fs.readFileSync(path.join(base, 'root', 'plug-config.json'), 'utf8'), 'cfg');
  });
});

describe('relocateFile / relocatePath', () => {
  it('moves a file, creating the destination parent', () => {
    const from = path.join(base, 'a.json');
    fs.writeFileSync(from, 'x');
    const to = path.join(base, 'deep', 'b.json');
    assert.deepEqual(relocateFile(from, to), { moved: true, kept: false });
    assert.equal(fs.readFileSync(to, 'utf8'), 'x');
    assert.equal(fs.existsSync(from), false);
  });

  it('never overwrites an existing destination file', () => {
    const from = path.join(base, 'a.json');
    const to = path.join(base, 'b.json');
    fs.writeFileSync(from, 'OLD');
    fs.writeFileSync(to, 'NEW');
    assert.deepEqual(relocateFile(from, to), { moved: false, kept: true });
    assert.equal(fs.readFileSync(to, 'utf8'), 'NEW', 'destination wins');
    assert.equal(fs.existsSync(from), true, 'source kept');
  });

  it('is a no-op for a missing source or a directory', () => {
    assert.deepEqual(relocateFile(path.join(base, 'nope'), path.join(base, 'x')), {
      moved: false,
      kept: false,
    });
    const d = seed(path.join(base, 'adir'));
    assert.deepEqual(relocateFile(d, path.join(base, 'x')), { moved: false, kept: false });
  });

  it('relocatePath dispatches on file vs directory', () => {
    const f = path.join(base, 'f.txt');
    fs.writeFileSync(f, 'F');
    assert.equal(relocatePath(f, path.join(base, 'moved-f.txt')).moved, true);

    const d = seed(path.join(base, 'd'));
    const res = relocatePath(d, path.join(base, 'moved-d'));
    assert.equal(res.moved, true);
    assert.equal(fs.existsSync(path.join(base, 'moved-d', 'a.md')), true);
  });
});

describe('relocateDirectory', () => {
  it('is a no-op when the source is absent', () => {
    const res = relocateDirectory(path.join(base, 'missing'), path.join(base, 'to'));
    assert.deepEqual(res, { moved: false, merged: false, kept: false });
    assert.equal(fs.existsSync(path.join(base, 'to')), false);
  });

  it('moves the directory when the destination is absent', () => {
    const from = seed(path.join(base, 'from'), { 'a.md': 'A', 'b.md': 'B' });
    const to = path.join(base, 'nested', 'to');
    const res = relocateDirectory(from, to);
    assert.equal(res.moved, true);
    assert.equal(res.merged, false);
    assert.equal(fs.existsSync(from), false, 'source is gone after a move');
    assert.deepEqual(fs.readdirSync(to).sort(), ['a.md', 'b.md']);
  });

  it('merges without clobbering when the destination exists', () => {
    const from = seed(path.join(base, 'from'), { 'shared.md': 'OLD', 'only-old.md': 'X' });
    const to = seed(path.join(base, 'to'), { 'shared.md': 'NEW' });
    const res = relocateDirectory(from, to);
    assert.equal(res.merged, true);
    assert.equal(res.moved, false);
    assert.equal(res.kept, true);
    assert.equal(fs.readFileSync(path.join(to, 'shared.md'), 'utf8'), 'NEW', 'destination wins');
    assert.equal(fs.readFileSync(path.join(to, 'only-old.md'), 'utf8'), 'X', 'gap is filled');
    assert.equal(fs.existsSync(from), true, 'merge keeps the source as a backup');
  });

  it('merges nested subtrees', () => {
    const from = path.join(base, 'from');
    seed(path.join(from, 'deep', 'er'), { 'x.md': 'X' });
    const to = seed(path.join(base, 'to'), { 'top.md': 'T' });
    relocateDirectory(from, to);
    assert.equal(fs.readFileSync(path.join(to, 'deep', 'er', 'x.md'), 'utf8'), 'X');
  });

  it('refuses to act when source and destination are the same path', () => {
    const dir = seed(path.join(base, 'same'));
    const res = relocateDirectory(dir, dir);
    assert.deepEqual(res, { moved: false, merged: false, kept: false });
    assert.equal(fs.existsSync(path.join(dir, 'a.md')), true);
  });

  it('relocateStore() reads legacyDir/dir off the migration context', () => {
    const legacyDir = seed(path.join(base, 'old'));
    const dir = path.join(base, 'new');
    relocateStore()({ legacyDir, dir });
    assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'A');
  });
});
