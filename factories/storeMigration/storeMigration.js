'use strict';

/**
 * storeMigration — versioned, fail-open migrations for a plugin's persisted
 * store directories.
 *
 * A store on disk outlives the code that wrote it. When a release changes
 * where a store lives or how its contents are shaped, every existing install
 * needs its data carried forward — silently, on the next session, without the
 * user reading a migration note. This factory is that mechanism.
 *
 * The decision matrix, in prose:
 *
 * VERSION STAMP. Each store directory carries a small JSON version file
 * (`.version.json` by default) holding `{ plugin, version, updatedAt }`.
 * `version` is the highest migration that has been applied to THAT directory.
 * Stores are versioned individually, never globally: the local, worktree,
 * global and shared tiers are independent data directories that an install
 * may have acquired at different times.
 *
 * BASELINE. Resolving the current version of a location is the only subtle
 * part, and it is deliberately explicit:
 *   - valid version file            → its `version`
 *   - dir exists, no version file   → 0 (predates versioning; migrate it)
 *   - dir exists, unreadable/garbage version file → 0 (same; a corrupt stamp
 *     must not strand data at an unknown version)
 *   - dir absent, legacyDir present → 0 (the data exists, at the old path)
 *   - dir absent, any `legacyPaths` entry present → 0 (same, for data the
 *     plugin keeps outside its store — a config file beside it, say)
 *   - dir absent, none of the above → null → NOTHING TO DO. This is the
 *     not-installed case, and it is why `run` never creates a store: a plugin
 *     the user never installed must not sprout an empty directory.
 *
 * ORDERING. Migrations are applied in ascending `version`, each exactly once,
 * and the stamp is written after each one succeeds — so an interrupted run
 * resumes at the first unapplied migration instead of replaying the whole
 * chain. Versions must be unique positive integers; gaps are allowed.
 *
 * FAIL-OPEN. `run` never throws and never writes to stderr. A migration that
 * throws stops the chain FOR THAT LOCATION ONLY, leaves the stamp at the last
 * version that did succeed, and is reported in `result.errors`. Every other
 * location still runs. A plugin whose migration fails degrades to "reads the
 * un-migrated store", which is exactly the pre-migration behavior — never a
 * broken session.
 *
 * CONCURRENCY. Several hooks (and several sessions) can fire at once, so each
 * location is guarded by an atomic `mkdir` lock placed BESIDE the store — a
 * lock inside it would vanish mid-migration when the directory is renamed. A
 * live lock means another process owns this location: skip it, report it, and
 * let that process finish. A lock older than `lockTimeoutMs` is treated as
 * abandoned (a crashed process) and stolen.
 *
 * The factory knows nothing about any particular plugin, root directory, or
 * on-disk layout: callers supply `locations(cwd)`, so the same runner serves
 * a relocation, a file-format rewrite, or a re-index.
 */

const fs = require('node:fs');
const path = require('node:path');

const { loadMigrations } = require('./load');
const { createFileLock } = require('./lock');

const DEFAULT_VERSION_FILE = '.version.json';
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
// Version reported for a store that exists but carries no readable stamp.
const UNVERSIONED = 0;

// ── config validation ────────────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(config, key) {
  const value = config[key];
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`storeMigration: "${key}" must be a non-empty string`);
  }
  return value;
}

function assertMigration(entry, seen) {
  if (!isPlainObject(entry)) {
    throw new TypeError('storeMigration: each migration must be an object');
  }
  const { version, migrate } = entry;
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError('storeMigration: migration "version" must be a positive integer');
  }
  if (seen.has(version)) {
    throw new TypeError(`storeMigration: duplicate migration version ${version}`);
  }
  if (typeof migrate !== 'function') {
    throw new TypeError(`storeMigration: migration ${version} needs a "migrate" function`);
  }
  seen.add(version);
  return Object.freeze({
    version,
    description: typeof entry.description === 'string' ? entry.description : '',
    migrate,
  });
}

// `migrationsDir` (one file per migration, discovered) is the shape plugins
// use; the inline `migrations` array stays for tests and for a caller that
// builds its list some other way. Exactly one of the two.
function resolveMigrationList(config) {
  const hasDir = typeof config.migrationsDir === 'string' && config.migrationsDir !== '';
  const hasArray = Array.isArray(config.migrations);
  if (hasDir && hasArray) {
    throw new TypeError('storeMigration: pass "migrationsDir" or "migrations", not both');
  }
  if (hasDir) return loadMigrations(config.migrationsDir);
  if (hasArray) return config.migrations;
  throw new TypeError('storeMigration: "migrationsDir" or "migrations" required');
}

function assertConfig(config) {
  if (!isPlainObject(config)) throw new TypeError('storeMigration: config object required');
  const plugin = requiredString(config, 'plugin');
  if (typeof config.locations !== 'function') {
    throw new TypeError('storeMigration: "locations" must be a function');
  }
  const declared = resolveMigrationList(config);
  if (declared.length === 0) {
    throw new TypeError('storeMigration: no migrations declared');
  }
  const seen = new Set();
  const migrations = declared
    .map((entry) => assertMigration(entry, seen))
    .sort((a, b) => a.version - b.version);
  return Object.freeze({
    plugin,
    locations: config.locations,
    migrations: Object.freeze(migrations),
    latest: migrations[migrations.length - 1].version,
    versionFile:
      config.versionFile === undefined
        ? DEFAULT_VERSION_FILE
        : requiredString(config, 'versionFile'),
    lockTimeoutMs:
      typeof config.lockTimeoutMs === 'number' && config.lockTimeoutMs > 0
        ? config.lockTimeoutMs
        : DEFAULT_LOCK_TIMEOUT_MS,
  });
}

// ── version stamp ────────────────────────────────────────────────────────────

function versionPath(spec, dir) {
  return path.join(dir, spec.versionFile);
}

function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(target) {
  try {
    fs.statSync(target);
    return true;
  } catch {
    return false;
  }
}

/** Recorded version of `dir`, or UNVERSIONED when the stamp is missing/unusable. */
function readStamp(spec, dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(versionPath(spec, dir), 'utf8'));
    const version = parsed && parsed.version;
    return Number.isInteger(version) && version >= 0 ? version : UNVERSIONED;
  } catch {
    return UNVERSIONED;
  }
}

/**
 * Current version of a location: an integer to act on, or null when there is
 * nothing installed here (see BASELINE in the header).
 */
function currentVersion(spec, location) {
  if (dirExists(location.dir)) return readStamp(spec, location.dir);
  if (location.legacyDir && dirExists(location.legacyDir)) return UNVERSIONED;
  // `legacyPaths` covers data a plugin keeps OUTSIDE its store — a config file
  // beside it, say. Without this the location reads as "not installed" and the
  // file is stranded at the old path forever, which for a security config
  // means it silently stops applying.
  if (Array.isArray(location.legacyPaths) && location.legacyPaths.some(pathExists)) {
    return UNVERSIONED;
  }
  return null;
}

/** Write the stamp. Best-effort: a store that cannot be stamped still works. */
function stampVersion(spec, dir, version, now) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const body = { plugin: spec.plugin, version, updatedAt: new Date(now()).toISOString() };
    fs.writeFileSync(versionPath(spec, dir), `${JSON.stringify(body, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

// ── run ──────────────────────────────────────────────────────────────────────

function pendingFrom(spec, version) {
  return spec.migrations.filter((m) => m.version > version);
}

/**
 * Apply every pending migration to one location, stamping after each success.
 * Returns { applied: number[], error: Error|null }.
 */
function migrateLocation(spec, location, version, now) {
  const applied = [];
  for (const migration of pendingFrom(spec, version)) {
    try {
      migration.migrate({
        dir: location.dir,
        legacyDir: location.legacyDir || null,
        legacyPaths: Array.isArray(location.legacyPaths) ? location.legacyPaths : [],
        kind: location.kind || null,
        plugin: spec.plugin,
        version: migration.version,
      });
    } catch (error) {
      return { applied, error };
    }
    applied.push(migration.version);
    // Only stamp a store that now exists — a no-op migration on an absent
    // location must not conjure the directory it declined to create.
    if (!dirExists(location.dir)) continue;
    if (stampVersion(spec, location.dir, migration.version, now)) continue;
    // The transformation happened but the record of it did not. Continuing
    // would stack migration N+1 on a store still recorded as pre-N, and the
    // next session would replay BOTH. Stop here and report: the replay is then
    // bounded to this one migration, and the operator learns the store is
    // unwritable rather than silently re-running transformations forever.
    return {
      applied,
      error: new Error(
        `storeMigration: applied migration ${migration.version} but could not write ` +
          `${spec.versionFile} in ${location.dir} — it will be replayed next run`
      ),
    };
  }
  return { applied, error: null };
}

// Beside the store, never inside it: a migration may rename the store
// directory itself, which would carry an inside-lock away mid-run.
function migrationLockPath(dir) {
  return path.join(path.dirname(dir), `.${path.basename(dir)}.migrating`);
}

function lockerFor(spec, now) {
  return createFileLock({
    lockPathFor: migrationLockPath,
    // Age-based only: a migration has no long-lived holder process to probe,
    // so a lock older than the timeout is assumed abandoned by a crash.
    staleAfterMs: spec.lockTimeoutMs,
    now,
  });
}

function runOne(spec, location, now, result) {
  const version = currentVersion(spec, location);
  if (version === null || version >= spec.latest) return;

  const locker = lockerFor(spec, now);
  // A live lock means another process owns this location: skip and report it
  // rather than wait — the other process is doing the same work.
  if (!locker.acquire(location.dir, { payload: { pid: process.pid } }).ok) {
    result.locked.push(location.dir);
    return;
  }
  try {
    // Re-read under the lock: another process may have finished while we
    // waited, which would otherwise replay a completed migration.
    const fresh = currentVersion(spec, location);
    if (fresh === null || fresh >= spec.latest) return;
    const { applied, error } = migrateLocation(spec, location, fresh, now);
    if (applied.length > 0) result.migrated.push({ dir: location.dir, from: fresh, applied });
    if (error) result.errors.push({ dir: location.dir, error });
  } finally {
    locker.release(location.dir);
  }
}

/** Bring every location for `cwd` up to LATEST_VERSION. Never throws. */
function runFor(spec, clock, cwd) {
  const result = { migrated: [], locked: [], errors: [] };
  let locations;
  try {
    locations = spec.locations(cwd) || [];
  } catch (error) {
    result.errors.push({ dir: null, error });
    return result;
  }
  for (const location of locations) {
    if (!isPlainObject(location) || typeof location.dir !== 'string' || !location.dir) continue;
    try {
      runOne(spec, location, clock, result);
    } catch (error) {
      result.errors.push({ dir: location.dir, error });
    }
  }
  return result;
}

/**
 * The installer-side dance, in one place because getting it wrong is silent
 * and permanent.
 *
 * An installer creating a store wants to stamp it at LATEST — a brand-new
 * store has nothing to migrate. But "new store" and "nothing to migrate" are
 * not the same thing: an older install's data can still be sitting at a legacy
 * path this location is responsible for. So migrate FIRST, and stamp only if
 * that migration actually settled.
 *
 * `run` is fail-open — it reports a location it skipped (another process held
 * the lock) or failed through its return value rather than throwing. Stamping
 * regardless marks the store fully migrated while data is still at the old
 * path, and because a stamp is believed on sight, no later session ever
 * retries. Leaving it unstamped is the safe direction: the next run picks the
 * work back up.
 *
 * @returns {{migration: object, stamped: boolean}}
 */
function prepareStore(spec, clock, cwd, dir) {
  const migration = runFor(spec, clock, cwd);
  const settled = migration.errors.length === 0 && migration.locked.length === 0;
  if (settled && dir) stampVersion(spec, dir, spec.latest, clock);
  return { migration, stamped: Boolean(settled && dir) };
}

function createStoreMigrator(config) {
  const spec = assertConfig(config);
  const clock = typeof config.now === 'function' ? config.now : () => Date.now();

  /**
   * Bring every location for `cwd` up to LATEST_VERSION. Never throws.
   * Returns { migrated, locked, errors } — all arrays, all possibly empty.
   */
  function run(opts) {
    return runFor(spec, clock, (opts && opts.cwd) || process.cwd());
  }

  return Object.freeze({
    LATEST_VERSION: spec.latest,
    // The resolved history, for callers that surface or assert on it.
    MIGRATIONS: spec.migrations,
    VERSION_FILE: spec.versionFile,
    readVersion: (dir) => (dirExists(dir) ? readStamp(spec, dir) : null),
    currentVersion: (location) => currentVersion(spec, location),
    pending: (version) => pendingFrom(spec, version).map((m) => m.version),
    stamp: (dir, version) => stampVersion(spec, dir, version, clock),
    stampLatest: (dir) => stampVersion(spec, dir, spec.latest, clock),
    run,
    // Positional alias for the one-liner hook call sites, so a plugin's runner
    // module can be `module.exports = createStoreMigrator({…})` with no
    // hand-written re-export block to keep in sync (or duplicate).
    runMigrations: (cwd) => run({ cwd }),
    prepareStore: (cwd, dir) => prepareStore(spec, clock, cwd, dir),
  });
}

module.exports = { createStoreMigrator, UNVERSIONED, DEFAULT_VERSION_FILE };
