# storeMigration

Versioned, fail-open migrations for a plugin's persisted store directories.

A store on disk outlives the code that wrote it. When a release changes where a
store lives or how its contents are shaped, every existing install needs its
data carried forward — silently, on the next session, without the user reading
a migration note. This factory is that mechanism; `relocate.js` ships the
"this store moved" migration body every plugin needs first.

## The version stamp

Each store directory carries `.version.json`:

```json
{ "plugin": "synapsys", "version": 1, "updatedAt": "2026-08-20T21:20:52.666Z" }
```

`version` is the highest migration applied to **that directory**. Stores are
versioned individually, never globally — local, worktree, home and shared are
independent data directories an install may have acquired at different times.

## Baseline resolution

The only subtle part, and deliberately explicit:

| State of the location | Resolved version | Effect |
|---|---|---|
| valid version file | its `version` | run migrations above it |
| dir exists, no version file | `0` | predates versioning — run everything |
| dir exists, corrupt version file | `0` | a bad stamp must not strand data at an unknown version |
| dir absent, `legacyDir` present | `0` | the data exists, at the old path |
| dir absent, `legacyDir` absent | `null` | **nothing to do** — never creates a store |

That last row is why `run` cannot conjure an empty directory for a plugin the
user never installed.

## Guarantees

| Property | How |
|---|---|
| **Ordered** | Ascending `version`, each applied exactly once. Versions are unique positive integers; gaps allowed. |
| **Resumable** | The stamp is written after *each* migration succeeds, so an interrupted run resumes at the first unapplied one instead of replaying the chain. |
| **Fail-open** | `run` never throws and never writes to stderr. A throwing migration stops that location's chain only, leaves the stamp at the last success, and lands in `result.errors`. Every other location still runs. |
| **Concurrent-safe** | Each location is guarded by an atomic `mkdir` lock placed *beside* the store — a lock inside it would vanish mid-migration when the directory is renamed. A live lock means another process owns the location: skip and report. A lock older than `lockTimeoutMs` (default 30s) is treated as abandoned and stolen. |
| **Idempotent** | A store already at `LATEST_VERSION` is skipped before the lock is even taken. |

## Config

| Key | Type | Effect |
|---|---|---|
| `plugin` | string (required) | Stamped into every version file. |
| `migrations` | array (required) | `{ version, description?, migrate(ctx) }`. Sorted by the factory; order of declaration is irrelevant. |
| `locations` | `(cwd) => location[]` (required) | The roots to consider. Each is `{ dir, legacyDir?, kind? }`. **Must be mutually disjoint** — handing the migrator a location nested inside another invites moving a parent out from under a queued child. |
| `versionFile` | string (default `.version.json`) | Stamp filename. |
| `lockTimeoutMs` | number (default `30000`) | Age at which a lock is considered abandoned. |
| `now` | `() => number` | Clock injection for tests. |

`migrate` receives `{ dir, legacyDir, kind, plugin, version }`.

Returned frozen API:

```
{ LATEST_VERSION, VERSION_FILE, readVersion, currentVersion,
  pending, stamp, stampLatest, run }
```

`run({ cwd })` → `{ migrated, locked, errors }`, all arrays, all possibly empty.

## relocateDirectory

The move-a-store migration, as one reviewed implementation rather than five
near-copies:

| Case | Behavior |
|---|---|
| `from` absent | no-op (the common case: fresh installs, every session after the first) |
| `to` absent | `rename(2)` — atomic on one filesystem; `EXDEV` falls back to copy-then-remove |
| `to` present | **merge, never clobber** — entries missing from `to` are copied in, entries already there win, and `from` is *kept* |

That last row is the "user reinstalled before upgrading" case: a fresh empty
store at the new path while the real data sits at the old one. Deleting the
user's only other copy on a guess is not a migration, it is data loss.

## Usage

```js
const { createStoreMigrator, relocateStore } = require('./storeMigration');
const { migrationCandidates } = require('./memory-store');

const migrator = createStoreMigrator({
  plugin: 'myplugin',
  migrations: [
    { version: 1, description: 'move out of the CLI config dir', migrate: relocateStore() },
  ],
  locations: (cwd) => migrationCandidates(cwd),
});

// SessionStart hook, BEFORE anything reads the store:
migrator.run({ cwd });
```

Append to the list, never renumber or edit a shipped entry — the declaration
list *is* the migration history. Have the plugin's installer call
`stampLatest(dir)` when it creates a store, so a fresh one starts at
`LATEST_VERSION` instead of replaying the chain.

`storeDiscovery.migrationCandidates(cwd)` supplies the four disjoint roots for
the `.claude` → `.workflow` relocation, each already paired with its
`legacyDir`.

## Why this shape

The alternative — a read-fallback that checks the old path whenever the new
one is empty — never converges: every plugin carries the fallback forever, two
sources of truth drift, and a partially-written store reads as "empty" and
silently resurrects stale data. A one-time, stamped, locked move has an end
state, and the stamp makes "which layout is this store in?" answerable without
guessing from directory contents.

Each flat `.js` file here loads standalone — node builtins and `./` siblings
only — so `scripts/sync-vendored.js` can byte-copy it into plugin trees that
must not `require()` across plugin boundaries at runtime.

## Not covered by this factory

- Where the locations are. Callers supply `locations(cwd)`; the factory knows
  nothing about any root directory or on-disk layout.
- Down-migration. Versions only go up; a downgrade reads a store stamped above
  `LATEST_VERSION` and leaves it alone.
- Cross-location ordering. Locations are independent and may run in any order,
  which is exactly why they must be disjoint.
