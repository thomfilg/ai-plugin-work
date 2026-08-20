// GENERATED — edit factories/storeMigration/storeMigration.js and run scripts/sync-vendored.js

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
 *   - dir absent, legacyDir absent  → null → NOTHING TO DO. This is the
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

function assertConfig(config) {
  if (!isPlainObject(config)) throw new TypeError('storeMigration: config object required');
  const plugin = requiredString(config, 'plugin');
  if (typeof config.locations !== 'function') {
    throw new TypeError('storeMigration: "locations" must be a function');
  }
  if (!Array.isArray(config.migrations) || config.migrations.length === 0) {
    throw new TypeError('storeMigration: "migrations" must be a non-empty array');
  }
  const seen = new Set();
  const migrations = config.migrations
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

// ── lock ─────────────────────────────────────────────────────────────────────

// Beside the store, never inside it: a migration may rename `dir` itself.
function lockPath(dir) {
  return path.join(path.dirname(dir), `.${path.basename(dir)}.migrating`);
}

function lockIsStale(lock, spec, now) {
  try {
    return now() - fs.statSync(lock).mtimeMs > spec.lockTimeoutMs;
  } catch {
    // Vanished between the failed mkdir and this stat — treat as free.
    return true;
  }
}

/** Atomic acquire via mkdir. Returns the lock path, or null if another process holds it. */
function acquireLock(spec, dir, now) {
  const lock = lockPath(dir);
  // The store's parent may not exist yet — the very first migration of a
  // relocated store creates it. Without this, mkdir(lock) fails ENOENT and the
  // location is misreported as held by another process, so the migration that
  // matters most never runs. Only reached once there IS something to migrate.
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
  } catch {
    /* the mkdir below reports the real problem */
  }
  try {
    fs.mkdirSync(lock, { recursive: false });
    return lock;
  } catch (err) {
    if (err.code !== 'EEXIST') return null;
    if (!lockIsStale(lock, spec, now)) return null;
    try {
      fs.rmSync(lock, { recursive: true, force: true });
      fs.mkdirSync(lock, { recursive: false });
      return lock;
    } catch {
      return null;
    }
  }
}

function releaseLock(lock) {
  try {
    fs.rmSync(lock, { recursive: true, force: true });
  } catch {
    /* best-effort */
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

function runOne(spec, location, now, result) {
  const version = currentVersion(spec, location);
  if (version === null || version >= spec.latest) return;

  const lock = acquireLock(spec, location.dir, now);
  if (!lock) {
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
    releaseLock(lock);
  }
}

function createStoreMigrator(config) {
  const spec = assertConfig(config);
  const clock = typeof config.now === 'function' ? config.now : () => Date.now();

  /**
   * Bring every location for `cwd` up to LATEST_VERSION. Never throws.
   * Returns { migrated, locked, errors } — all arrays, all possibly empty.
   */
  function run(opts) {
    const result = { migrated: [], locked: [], errors: [] };
    let locations;
    try {
      locations = spec.locations((opts && opts.cwd) || process.cwd()) || [];
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

  return Object.freeze({
    LATEST_VERSION: spec.latest,
    VERSION_FILE: spec.versionFile,
    readVersion: (dir) => (dirExists(dir) ? readStamp(spec, dir) : null),
    currentVersion: (location) => currentVersion(spec, location),
    pending: (version) => pendingFrom(spec, version).map((m) => m.version),
    stamp: (dir, version) => stampVersion(spec, dir, version, clock),
    stampLatest: (dir) => stampVersion(spec, dir, spec.latest, clock),
    run,
  });
}

module.exports = { createStoreMigrator, UNVERSIONED, DEFAULT_VERSION_FILE };
