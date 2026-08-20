'use strict';

/**
 * Maestro store migrations — the runner.
 *
 * History lives in `lib/migrations/`, one file per migration named
 * `<YYYYMMDDHHMMSS>_<slug>.js`. Adding one means adding a FILE; nothing here
 * changes. Never rename or edit a shipped migration — its timestamp is the
 * version already stamped into users' stores.
 *
 * See `factories/storeMigration` for version/baseline/lock semantics.
 */

const path = require('node:path');
const { createStoreMigrator } = require(path.join(__dirname, 'storeMigration'));
const { migrationCandidates } = require(path.join(__dirname, 'schema-store'));

module.exports = createStoreMigrator({
  plugin: 'maestro',
  migrationsDir: path.join(__dirname, 'migrations'),
  locations: (cwd) => migrationCandidates(cwd),
});
