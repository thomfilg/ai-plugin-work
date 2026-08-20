'use strict';

/**
 * Synapsys store migrations.
 *
 * The declaration list below IS the migration history: append an entry, never
 * renumber or edit a shipped one. Every store directory records the highest
 * version applied to it in `.version.json`; on SessionStart the runner brings
 * each one up to `LATEST_VERSION` and stamps it. See
 * `factories/storeMigration` for the version/baseline/lock semantics.
 *
 * Locations come from `migrationCandidates`, which returns four DISJOINT
 * roots — local, worktree, the whole per-user `~/.workflow/synapsys`
 * namespace, and the cross-project shared store. The `home` row is what
 * carries synapsys's loose per-user state (`.telemetry/`, `.session/`,
 * `.cache/`, `.state/`, `config.yaml`, `DOMAINS.md`) along with every
 * project's global store, since all of it lives inside that one namespace.
 */

const path = require('node:path');
const { createStoreMigrator, relocateStore } = require(path.join(__dirname, 'storeMigration'));
const { migrationCandidates } = require(path.join(__dirname, 'memory-store'));

const MIGRATIONS = [
  {
    version: 1,
    description: 'move the store out of the agent CLI config dir into .workflow/',
    // v3.85.8 relocated every plugin store from `.claude/<folder>` to
    // `.workflow/<folder>`. Installs predating it keep their memories at the
    // old path; without this they read as an empty store.
    migrate: relocateStore(),
  },
];

const migrator = createStoreMigrator({
  plugin: 'synapsys',
  migrations: MIGRATIONS,
  locations: (cwd) => migrationCandidates(cwd),
});

module.exports = {
  MIGRATIONS,
  LATEST_VERSION: migrator.LATEST_VERSION,
  VERSION_FILE: migrator.VERSION_FILE,
  runMigrations: (cwd) => migrator.run({ cwd }),
  readVersion: migrator.readVersion,
  stampLatest: migrator.stampLatest,
};
