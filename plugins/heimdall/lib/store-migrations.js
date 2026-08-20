'use strict';

/**
 * Heimdall store migrations — the runner.
 *
 * History lives in `lib/migrations/`, one file per migration named
 * `<YYYYMMDDHHMMSS>_<slug>.js`. Adding one means adding a FILE; nothing here
 * changes. Never rename or edit a shipped migration — its timestamp is the
 * version already stamped into users' stores.
 *
 * Beyond the four store roots, every repo-rooted location also declares the
 * conceal config and its block log as `legacyPaths`. They sit BESIDE the store
 * (`<root>/heimdall-conceal.json`, not `<root>/heimdall/…`), so the store move
 * alone would leave them behind — and a stranded conceal config means the
 * guard silently stops concealing.
 *
 * See `factories/storeMigration` for version/baseline/lock semantics.
 */

const path = require('node:path');
const { createStoreMigrator } = require(path.join(__dirname, 'storeMigration'));
const lockStore = require(path.join(__dirname, 'lock-store'));

const CONCEAL_FILES = ['heimdall-conceal.json', 'heimdall-conceal.log'];

// The conceal config is per-repo, so it rides the repo-rooted rows only. The
// home/shared rows are user-wide and never carried one.
const REPO_ROOTED = new Set(['local', 'worktree']);

function locations(cwd) {
  return lockStore.migrationCandidates(cwd).map((row) => {
    if (!REPO_ROOTED.has(row.kind)) return row;
    const legacyRoot = path.dirname(row.legacyDir);
    return { ...row, legacyPaths: CONCEAL_FILES.map((f) => path.join(legacyRoot, f)) };
  });
}

module.exports = createStoreMigrator({
  plugin: 'heimdall',
  migrationsDir: path.join(__dirname, 'migrations'),
  locations,
});
