# storeDiscovery

Factory for tiered, marker-gated store discovery. A "store" is a directory
under `.claude/<folder>` holding a plugin's persisted artifacts, gated by a
marker file so only explicitly installed locations are ever read. The factory
returns a frozen API bound to one caller's folder/marker names and behavioral
dials, replacing the hand-copied discovery block each store module used to
carry.

Tiers, discovered in fixed precedence order (`PRECEDENCE_ORDER`):

| Tier | Directory | Notes |
|---|---|---|
| `local` | `<cwd>/.claude/<folder>` | |
| `worktree` | nearest ancestor of cwd carrying the marker | ancestor walk from `dirname(cwd)`, not a fixed parent row |
| `global` | `~/.claude/<folder>/<projectName>` | per-project namespace under home |
| `shared` | `~/.claude/<folder>-shared` | cross-project; always `projectName: null` |

## Decision matrix

| Config key | Type | Effect |
|---|---|---|
| `folder` | string (required) | Store directory name. The shared tier derives `<folder>-shared`, a **sibling** of the per-project namespace, so a project named like the shared folder can never shadow it. |
| `marker` | string (required) | Marker filename gating every tier (e.g. `.myplugin.json`). |
| `projectNameStrategy` | `'git-common-dir'` \| `'toplevel'` (required) | `git-common-dir`: prefer `git rev-parse --path-format=absolute --git-common-dir`; when its basename is `.git`, the parent's basename is the MAIN repo name (a linked worktree resolves to the main checkout, not the worktree dir); falls back to the toplevel basename, then `basename(cwd)`. `toplevel`: `basename(toplevel \|\| cwd)`. |
| `ancestorWalkStopsAtHome` | boolean (default `false`) | `true`: the worktree walk checks each directory's marker FIRST, then stops at the user's home — a marker AT `~/.claude/<folder>` stays discoverable, but the walk never continues PAST home, so a sandboxed `$HOME` cannot leak the real user's store. `false`: walk to the filesystem root. Exhaustion returns `''` either way. |
| `disableHomeStoresEnvVar` | string \| null (default `null`) | When set and `process.env[name] === '1'` at discovery time, the home-rooted tiers (global + shared) are skipped — lets test suites pin discovery to cwd-rooted fixtures. `null` disables the gate. |

Returned frozen API:

```
{ MARKER, FOLDER, SHARED_FOLDER, PRECEDENCE_ORDER,
  safeExec, getRepoRoot, getProjectName,
  candidateStores, findAncestorStore, discoverStores }
```

`discoverStores(cwd)` returns `[{ kind, dir, projectName }]` — active stores
(marker present) in precedence order, de-duplicated by resolved dir, shared
tier stamped `projectName: null`. `candidateStores(cwd, projectName)` returns
the four canonical rows whether or not they are installed (installers use it
to pick a target). `safeExec(cmd, cwd)` fails open to `''`.

## Usage

```js
const { createStoreDiscovery } = require('./storeDiscovery'); // vendored sibling

const discovery = createStoreDiscovery({
  folder: 'myplugin',
  marker: '.myplugin.json',
  projectNameStrategy: 'toplevel',
  ancestorWalkStopsAtHome: true,
  disableHomeStoresEnvVar: 'MYPLUGIN_DISABLE_HOME_STORES',
});

module.exports = {
  ...discovery,
  // plugin-specific store IO (read/write/merge) layers on top
};
```

## Why this shape

Multiple plugins persist per-project state under `.claude/<folder>` and had
byte-identical (or structurally obfuscated) copies of the same ~100-line
discovery block, drifting one bugfix at a time: one copy gained a HOME-bounded
ancestor walk, another a worktree-aware project name, another an env gate for
tests. The union of those variants is exactly four dials, so the factory makes
them config: callers pick values for the table, and every behavioral invariant
(per-call `os.homedir()` resolution, fail-open IO, marker gating,
PRECEDENCE_ORDER-driven output, dedupe by resolved dir, `projectName: null`
on the shared tier) is enforced in one place.

Each flat `.js` file here loads standalone — node builtins and `./` siblings
only — so `scripts/sync-vendored.js` can byte-copy it into plugin trees that
must not `require()` across plugin boundaries at runtime.

## Not covered by this factory

- Reading or writing what is INSIDE a store: per-file formats, frontmatter
  parsing, config IO, merge/conflict policy between tiers. Callers own that.
- Writing markers / initializing stores (`candidateStores` gives installers
  the four canonical rows; creating one is the installer's job).
- Caching. Every call re-reads the filesystem and environment by design —
  callers that need memoization add it on their side.
