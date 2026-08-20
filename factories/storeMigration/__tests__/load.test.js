'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadMigrations, createStoreMigrator } = require('../index');

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-load-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name, body) {
  fs.writeFileSync(path.join(dir, name), body);
}

const NOOP = "'use strict';\nmodule.exports = { migrate() {} };\n";

describe('loadMigrations', () => {
  it('returns [] for a directory that does not exist yet', () => {
    assert.deepEqual(loadMigrations(path.join(dir, 'nope')), []);
  });

  it('takes the version from the filename, ascending, regardless of readdir order', () => {
    write('20260301120000_third.js', NOOP);
    write('20260101120000_first.js', NOOP);
    write('20260201120000_second.js', NOOP);
    assert.deepEqual(
      loadMigrations(dir).map((m) => m.version),
      [20260101120000, 20260201120000, 20260301120000]
    );
  });

  it('defaults the description to the slug, and prefers an exported one', () => {
    write('20260101120000_move-the-store.js', NOOP);
    write(
      '20260102120000_other.js',
      "'use strict';\nmodule.exports = { description: 'a real sentence', migrate() {} };\n"
    );
    const [a, b] = loadMigrations(dir);
    assert.equal(a.description, 'move-the-store');
    assert.equal(b.description, 'a real sentence');
  });

  it('THROWS on a malformed .js filename rather than skipping it', () => {
    // Silently skipping is the worst failure: the migration looks committed,
    // never runs, and the store gets stamped as though it had.
    write('20260101120000_ok.js', NOOP);
    write('oops-no-timestamp.js', NOOP);
    assert.throws(() => loadMigrations(dir), /not a valid migration filename/);
  });

  it('rejects a short timestamp, a bad separator and a non-kebab slug', () => {
    for (const bad of ['202601011200_x.js', '20260101120000-x.js', '20260101120000_Bad_Slug.js']) {
      fs.rmSync(path.join(dir, bad), { force: true });
      write(bad, NOOP);
      assert.throws(() => loadMigrations(dir), /not a valid migration filename/, bad);
      fs.rmSync(path.join(dir, bad));
    }
  });

  it('ignores non-.js entries so a README or subdirectory can live alongside', () => {
    write('20260101120000_ok.js', NOOP);
    write('README.md', '# migrations\n');
    fs.mkdirSync(path.join(dir, 'fixtures'));
    assert.equal(loadMigrations(dir).length, 1);
  });

  it('throws when a migration module has no migrate function', () => {
    write('20260101120000_broken.js', "'use strict';\nmodule.exports = { description: 'x' };\n");
    assert.throws(() => loadMigrations(dir), /must export a "migrate" function/);
  });

  it('wires into createStoreMigrator via migrationsDir', () => {
    write('20260101120000_first.js', NOOP);
    write('20260202120000_second.js', NOOP);
    const migrator = createStoreMigrator({
      plugin: 'acme',
      migrationsDir: dir,
      locations: () => [],
    });
    assert.equal(migrator.LATEST_VERSION, 20260202120000);
    assert.deepEqual(
      migrator.MIGRATIONS.map((m) => m.version),
      [20260101120000, 20260202120000]
    );
  });

  it('a duplicate version across two files is rejected', () => {
    write('20260101120000_a.js', NOOP);
    // Same timestamp, different slug — the version, not the name, must be unique.
    fs.writeFileSync(path.join(dir, '20260101120000_b.js'), NOOP);
    assert.throws(
      () => createStoreMigrator({ plugin: 'acme', migrationsDir: dir, locations: () => [] }),
      /duplicate migration version/
    );
  });
});
