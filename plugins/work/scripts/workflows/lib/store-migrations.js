'use strict';

/**
 * work-workflow store migrations — the runner.
 *
 * History lives in `lib/migrations/`, one file per migration named
 * `<YYYYMMDDHHMMSS>_<slug>.js`. Adding one means adding a FILE; nothing here
 * changes. Never rename or edit a shipped migration — its timestamp is the
 * version already stamped into users' stores.
 *
 * Unlike synapsys / heimdall / maestro, work-workflow has no marker-gated
 * storeDiscovery store — its state is one fixed per-user directory — so the
 * location is spelled out here rather than derived from tier geometry. The
 * roots below must stay in step with `factories/storeDiscovery`
 * (ROOT_DIR / LEGACY_ROOT_DIR); vendoring the whole discovery factory for two
 * string constants would cost more than it saves.
 *
 * DELIBERATELY NOT MIGRATED:
 *   ~/.claude/.cache, ~/.claude/.agent-runtime — regenerable caches (update
 *     banner, env detection, runtime stamp). Losing them costs one re-check.
 *     They are also written by every plugin, so no single one owns the move.
 *   ~/.claude/statusline-host.sh, ~/.claude/statuslines/ — installer-managed
 *     and version-stamped (HOST_VERSION), so the installer rewrites them at
 *     the new path; the stale copies are inert.
 *
 * See `factories/storeMigration` for version/baseline/lock semantics.
 */

const os = require('node:os');
const path = require('node:path');
const { createStoreMigrator } = require(path.join(__dirname, 'storeMigration'));

const ROOT_DIR = '.workflow';
const LEGACY_ROOT_DIR = '.claude';
const STATE_FOLDER = 'work-workflow';

function locations() {
  const home = os.homedir();
  return [
    {
      kind: 'home',
      dir: path.join(home, ROOT_DIR, STATE_FOLDER),
      legacyDir: path.join(home, LEGACY_ROOT_DIR, STATE_FOLDER),
    },
  ];
}

module.exports = Object.freeze({
  ...createStoreMigrator({
    plugin: 'work-workflow',
    migrationsDir: path.join(__dirname, 'migrations'),
    locations,
  }),
  // Exported so a test can assert these stay in step with storeDiscovery.
  ROOT_DIR,
  LEGACY_ROOT_DIR,
  STATE_FOLDER,
});
