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
{ "plugin": "synapsys", "version": 20260820213000, "updatedAt": "2026-08-20T21:20:52.666Z" }
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
| dir absent, any `legacyPaths` entry present | `0` | same, for data kept *outside* the store |
| dir absent, `legacyDir` absent | `null` | **nothing to do** — never creates a store |

That last row is why `run` cannot conjure an empty directory for a plugin the
user never installed.

## Guarantees

| Property | How |
|---|---|
| **Ordered** | Ascending `version`, each applied exactly once. Versions are the unique `YYYYMMDDHHMMSS` timestamps parsed from the filenames. |
| **Resumable** | The stamp is written after *each* migration succeeds, so an interrupted run resumes at the first unapplied one instead of replaying the chain. |
| **Fail-open** | `run` never throws and never writes to stderr. A throwing migration stops that location's chain only, leaves the stamp at the last success, and lands in `result.errors`. Every other location still runs. |
| **Concurrent-safe** | Each location is guarded by an atomic exclusive-create lock placed *beside* the store — a lock inside it would vanish mid-migration when the directory is renamed. A live lock means another process owns the location: skip and report. A lock older than `lockTimeoutMs` (default 30s) is treated as abandoned and stolen. See [the shared lock](#lock--shared-with-the-conductor-and-task-claims). |
| **Idempotent** | A store already at `LATEST_VERSION` is skipped before the lock is even taken. |

## Config

| Key | Type | Effect |
|---|---|---|
| `plugin` | string (required) | Stamped into every version file. |
| `migrationsDir` | string | Directory of one-file-per-migration modules (see below). Mutually exclusive with `migrations`; one of the two is required. |
| `migrations` | array | `{ version, description?, migrate(ctx) }`, for tests or a caller that builds its list another way. Sorted by the factory. |
| `locations` | `(cwd) => location[]` (required) | The roots to consider. Each is `{ dir, legacyDir?, legacyPaths?, kind? }`. **Must be mutually disjoint** — handing the migrator a location nested inside another invites moving a parent out from under a queued child. |
| `versionFile` | string (default `.version.json`) | Stamp filename. |
| `lockTimeoutMs` | number (default `30000`) | Age at which a lock is considered abandoned. |
| `now` | `() => number` | Clock injection for tests. |

`migrate` receives `{ dir, legacyDir, legacyPaths, kind, plugin, version }`.

### legacyPaths — data kept outside the store

Some plugins keep a config *beside* the store rather than inside it
(`<root>/plugin-config.json` next to `<root>/plugin/`). Listing those old paths
in `legacyPaths` does two things: it makes the location count as installed even
when no store directory exists, and `relocateStore()` carries each entry into
the new store's parent.

Without it such a file is stranded at the old path forever. That is worse than
it sounds when the file is a security config that is *safe-by-default-off* —
nothing errors, the feature just quietly stops applying. heimdall's conceal
policy is exactly that case.

Returned frozen API:

```
{ LATEST_VERSION, VERSION_FILE, MIGRATIONS, readVersion, currentVersion,
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

`relocateFile` is the single-file counterpart (same non-destructive rule: an
existing destination wins and the source is kept), and `relocatePath`
dispatches on whichever the source happens to be.

That last row is the "user reinstalled before upgrading" case: a fresh empty
store at the new path while the real data sits at the old one. Deleting the
user's only other copy on a guess is not a migration, it is data loss.

## One migration per file

Migrations live in a folder, one file each, named
`<YYYYMMDDHHMMSS>_<kebab-slug>.js`:

```
lib/migrations/
  20260820213000_relocate-store-root.js
  20261102090000_rewrite-frontmatter-dates.js
```

```js
// 20260820213000_relocate-store-root.js
module.exports = {
  description: 'move the store out of the agent CLI config dir into .workflow/',
  migrate: relocateStore(),
};
```

**The filename is the version.** The module exports no `version` field —
that would be the same value written twice, free to drift. Timestamps rather
than `0001`, `0002`, … so two branches authoring migrations on the same day
get distinct, correctly-ordered versions instead of both claiming the next
integer. 14 digits is ~2.0e13, comfortably inside the safe-integer range.

Adding a migration means adding a **file**; no shared list is edited, so two
branches never collide on the same lines. Never rename or edit a shipped
migration — its timestamp is the version already stamped into users' stores.

A `.js` file whose name does not parse **throws**. Silently skipping it is the
worst available failure: the migration looks committed, never runs, and the
store is stamped as though it had. Non-`.js` entries are ignored, so a README
can sit in the folder.

## Usage

```js
const { createStoreMigrator } = require('./storeMigration');
const { migrationCandidates } = require('./memory-store');

const migrator = createStoreMigrator({
  plugin: 'myplugin',
  migrationsDir: path.join(__dirname, 'migrations'),
  locations: (cwd) => migrationCandidates(cwd),
});

// SessionStart hook, BEFORE anything reads the store:
migrator.run({ cwd });
```

Have the plugin's installer call `stampLatest(dir)` when it creates a store,
so a fresh one starts at `LATEST_VERSION` instead of replaying the chain.

`storeDiscovery.migrationCandidates(cwd)` supplies the four disjoint roots for
the `.claude` → `.workflow` relocation, each already paired with its
`legacyDir`.

## lock — shared with the conductor and task claims

`lock.js` is not migration-specific. Three subsystems needed the same
primitive and had grown three implementations of it:

| Caller | Guards | Holder stops counting when |
|---|---|---|
| the migration runner | a store, while its chain runs | its mtime exceeds `lockTimeoutMs` |
| `maestro` conductor-lock | one daemon per namespace | its pid is no longer a live other process |
| `work-workflow` work-claims | one owner per task | never — a claim is held until released |

All three are *create exclusively → inspect the holder → reclaim or refuse →
release*. Only three things genuinely differed, so those are the config:
`lockPathFor` (where the file sits), `staleAfterMs` / `isHolderDead` (when a
holder stops counting), and `force` at acquire time (may a caller displace a
live holder). Everything else — O_EXCL atomicity, bounded retry on a lost
reclaim race, JSON payload, refuse-if-unreadable, ownership-checked release —
lives here once.

What deliberately did **not** move: ownership *policy*. Same-owner idempotent
reclaim, the conductor's `{ok, held, forced}` shape, and work-claims'
structured `ALREADY_CLAIMED` / `WRONG_OWNER` errors all stay with their
callers. The shared code owns atomicity; each caller owns who may hold what.

Callers reach it intra-plugin (`…/lib/storeMigration/lock`) — cross-*plugin*
requires break on codex, but requires inside one plugin's install snapshot are
fine, so this adds no vendored files.

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
