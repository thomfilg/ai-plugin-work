'use strict';

/**
 * Synapsys store migrations — the runner.
 *
 * The history itself lives in `lib/migrations/`, one file per migration named
 * `<YYYYMMDDHHMMSS>_<slug>.js`. Adding one means adding a FILE; nothing here
 * changes, and two branches authoring migrations never collide on the same
 * lines. Never rename or edit a shipped migration — its timestamp is the
 * version already stamped into users' stores.
 *
 * Locations come from `migrationCandidates`, which returns four DISJOINT
 * roots — local, the worktree store found by the same ancestor walk discovery
 * uses, the whole per-user `~/.workflow/synapsys` namespace, and the
 * cross-project shared store. The `home` row is what carries synapsys's loose
 * per-user state (`.telemetry/`, `.session/`, `.cache/`, `.state/`,
 * `config.yaml`, `DOMAINS.md`) along with every project's global store.
 *
 * See `factories/storeMigration` for version/baseline/lock semantics.
 */

const path = require('node:path');
const { createStoreMigrator } = require(path.join(__dirname, 'storeMigration'));
const { migrationCandidates } = require(path.join(__dirname, 'memory-store'));

const migrator = createStoreMigrator({
  plugin: 'synapsys',
  migrationsDir: path.join(__dirname, 'migrations'),
  locations: (cwd) => migrationCandidates(cwd),
});

module.exports = {
  LATEST_VERSION: migrator.LATEST_VERSION,
  VERSION_FILE: migrator.VERSION_FILE,
  MIGRATIONS: migrator.MIGRATIONS,
  runMigrations: (cwd) => migrator.run({ cwd }),
  readVersion: migrator.readVersion,
  stampLatest: migrator.stampLatest,
};
