// GENERATED — edit factories/storeDiscovery/storeDiscovery.js and run scripts/sync-vendored.js

'use strict';

/**
 * storeDiscovery — factory for tiered, marker-gated store discovery.
 *
 * Plugins persist per-project artifacts in a "store": a directory under
 * `.workflow/<folder>` gated by a marker file, so only explicitly installed
 * locations are ever read. `.workflow` is this marketplace's own root and sits
 * exactly where the agent CLI's `.claude` config dir sits — as its sibling —
 * so plugin data is never mixed into the CLI's config. Stores are discovered
 * across four tiers and returned in a fixed precedence order:
 *
 *   local    → <cwd>/.workflow/<folder>
 *   worktree → nearest ancestor above cwd carrying the marker
 *   global   → ~/.workflow/<folder>/<projectName>
 *   shared   → ~/.workflow/<folder>-shared   (cross-project)
 *
 * The decision matrix IS the config:
 *
 * - `folder` / `marker` name the store directory and its gate file. `folder`
 *   is the bare plugin name (`synapsys`); every tier materializes it under
 *   ROOT_DIR as `.workflow/<folder>`. The shared tier always lives at
 *   `<folder>-shared`, a SIBLING of the per-project namespace, so a project
 *   whose name happens to match the shared folder can never shadow it.
 * - `projectNameStrategy` picks how the global tier derives its name.
 *   'git-common-dir' prefers the git common dir so a linked worktree
 *   resolves to the MAIN repo name (the common dir is `<main>/.git` for the
 *   main checkout and every linked worktree), falling back to the toplevel
 *   basename, then basename(cwd). 'toplevel' is basename(toplevel || cwd).
 * - `ancestorWalkStopsAtHome` bounds the worktree ancestor walk. When true,
 *   each directory's marker is checked FIRST and the walk then stops at the
 *   user's home directory: a marker AT `$HOME/.workflow/<folder>` stays
 *   discoverable, but the walk never continues PAST home (a sandboxed $HOME
 *   cannot leak the real user's store). When false the walk continues to
 *   the filesystem root. Either way exhaustion returns ''.
 * - `disableHomeStoresEnvVar` optionally names an env var that, when set to
 *   '1' at discovery time, skips the home-rooted tiers (global + shared) —
 *   used by test suites to pin discovery to cwd-rooted fixtures.
 *
 * Invariants preserved for every caller:
 * - `os.homedir()` is resolved per call, never cached at module load, so
 *   suites that reassign `process.env.HOME` observe the override (POSIX).
 * - IO fails open: `safeExec` returns '' on any failure, discovery never
 *   throws for missing directories, and nothing is written to stderr.
 * - `discoverStores` is data-driven off PRECEDENCE_ORDER, gates every tier
 *   on marker existence, tolerates a falsy tier dir, de-duplicates by
 *   resolved dir, and stamps the shared tier with `projectName: null`
 *   (it is cross-project by design).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

// Discovery/precedence order shared by every store instance. When the same
// artifact exists in multiple tiers, earlier kinds win downstream.
const PRECEDENCE_ORDER = Object.freeze(['local', 'worktree', 'global', 'shared']);
// Tiers rooted under os.homedir() — the ones the env gate can switch off.
const HOME_TIERS = new Set(['global', 'shared']);
const PROJECT_NAME_STRATEGIES = new Set(['git-common-dir', 'toplevel']);
// Marketplace-owned root for every persisted store, at the same level the
// agent CLI's own `.claude` config dir would sit (repo root / $HOME). Plugins
// never write inside `.claude`.
const ROOT_DIR = '.workflow';
// Where the tiers lived before ROOT_DIR existed. Read-only history: discovery
// never looks here, but store migrations need the old geometry to find data
// left behind by an older install, so it is derived from the SAME tier switch
// rather than re-hardcoded per plugin.
const LEGACY_ROOT_DIR = '.claude';

// ── config validation ────────────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(config, key) {
  const value = config[key];
  if (value === undefined) throw new TypeError(`storeDiscovery: missing "${key}"`);
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`storeDiscovery: "${key}" must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(config, key) {
  const value = config[key];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new TypeError(`storeDiscovery: "${key}" must be a boolean`);
  }
  return value;
}

function optionalEnvVarName(config, key) {
  const value = config[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`storeDiscovery: "${key}" must be a non-empty string or null`);
  }
  return value;
}

function assertConfig(config) {
  if (!isPlainObject(config)) throw new TypeError('storeDiscovery: config object required');
  const folder = requiredString(config, 'folder');
  const marker = requiredString(config, 'marker');
  const strategy = requiredString(config, 'projectNameStrategy');
  if (!PROJECT_NAME_STRATEGIES.has(strategy)) {
    throw new TypeError(
      'storeDiscovery: invalid "projectNameStrategy" — expected "git-common-dir" or "toplevel"'
    );
  }
  return Object.freeze({
    folder,
    marker,
    sharedFolder: `${folder}-shared`,
    strategy,
    stopsAtHome: optionalBoolean(config, 'ancestorWalkStopsAtHome'),
    envVar: optionalEnvVarName(config, 'disableHomeStoresEnvVar'),
  });
}

// ── git helpers ──────────────────────────────────────────────────────────────

// Pass cwd through to execSync so git resolves relative to the caller's path,
// not the host process's cwd — hooks may be invoked from one cwd while
// processing a payload with a different one. Fails open to ''.
function safeExec(cmd, cwd) {
  const opts = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    return execSync(cmd, opts).trim();
  } catch {
    return '';
  }
}

/** Git toplevel of cwd, or cwd itself when not in a repo. */
function getRepoRoot(cwd) {
  const base = cwd || process.cwd();
  return safeExec('git rev-parse --show-toplevel', base) || base;
}

// 'git-common-dir': inside a linked worktree, --show-toplevel returns the
// worktree directory, which would derive a divergent global-store name. The
// common dir is `<main-checkout>/.git` for the main checkout and every linked
// worktree, so its parent's basename is the real repo name. Guarded on the
// `.git` basename so bare repos and exotic GIT_DIR layouts fall through to
// the toplevel/cwd fallback.
function projectNameOf(spec, cwd) {
  const base = cwd || process.cwd();
  if (spec.strategy === 'git-common-dir') {
    const commonDir = safeExec('git rev-parse --path-format=absolute --git-common-dir', base);
    if (commonDir && path.basename(commonDir) === '.git') {
      return path.basename(path.dirname(commonDir));
    }
  }
  return path.basename(getRepoRoot(base));
}

// ── tier geometry ────────────────────────────────────────────────────────────

// Canonical directory for one tier under `root`. os.homedir() is deliberately
// read here, at call time, so a reassigned $HOME is honored per call. `root`
// is ROOT_DIR for live discovery and LEGACY_ROOT_DIR when a migration is
// looking for data an older install left behind — the geometry is identical
// either way, which is the whole point of taking it as a parameter.
function tierDirUnder(spec, root, kind, cwd, projectName) {
  switch (kind) {
    case 'local':
      return path.join(cwd, root, spec.folder);
    case 'worktree':
      return path.resolve(cwd, '..', root, spec.folder);
    case 'global':
      return path.join(os.homedir(), root, spec.folder, projectName);
    case 'shared':
      return path.join(os.homedir(), root, spec.sharedFolder);
    default:
      return '';
  }
}

function tierDirOf(spec, kind, cwd, projectName) {
  return tierDirUnder(spec, ROOT_DIR, kind, cwd, projectName);
}

function candidateRows(spec, cwd, projectName) {
  return PRECEDENCE_ORDER.map((kind) => ({ kind, dir: tierDirOf(spec, kind, cwd, projectName) }));
}

// Roots a migration must carry forward, each paired with its pre-ROOT_DIR
// location: `{ kind, dir, legacyDir }`. Deliberately NOT the four discovery
// tiers — `global` is `~/<root>/<folder>/<project>`, which lives INSIDE
// `~/<root>/<folder>`, and handing a migrator two locations where one
// contains the other invites moving a parent out from under a queued child.
// The `home` row covers the whole per-user namespace instead: every project's
// global store plus any loose state the plugin keeps beside them. The four
// rows returned here are mutually disjoint.
function migrationRows(spec, cwd) {
  const home = os.homedir();
  const pair = (kind, tail) => ({
    kind,
    dir: path.join(...tail(ROOT_DIR)),
    legacyDir: path.join(...tail(LEGACY_ROOT_DIR)),
  });
  // The worktree row must mirror DISCOVERY, which resolves this tier with an
  // ancestor WALK, not a fixed parent row. A session started from
  // `<worktree>/packages/app` discovers a store at `<worktree>/`; checking only
  // `<cwd>/..` would leave exactly that store unmigrated and then invisible,
  // since post-migration discovery no longer looks under the legacy root.
  // Fall back to the immediate parent when the walk finds nothing, so an
  // already-migrated store at `<cwd>/..` still resolves and gets stamped.
  const base = ancestorMigrationBase(spec, path.dirname(cwd));
  const worktree = {
    kind: 'worktree',
    dir: base
      ? path.join(base, ROOT_DIR, spec.folder)
      : path.resolve(cwd, '..', ROOT_DIR, spec.folder),
    legacyDir: base
      ? path.join(base, LEGACY_ROOT_DIR, spec.folder)
      : path.resolve(cwd, '..', LEGACY_ROOT_DIR, spec.folder),
  };

  const rows = [
    pair('local', (root) => [cwd, root, spec.folder]),
    worktree,
    pair('home', (root) => [home, root, spec.folder]),
    pair('shared', (root) => [home, root, spec.sharedFolder]),
  ];
  // The walk can land on a row another tier already covers (a repo directly
  // under $HOME resolves the worktree row to the home namespace). Rows must
  // stay distinct so one location is never migrated twice.
  const seen = new Set();
  return rows.filter((row) => {
    const key = path.resolve(row.dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── ancestor walk ────────────────────────────────────────────────────────────

// Nearest ancestor of startDir carrying `<ancestor>/.workflow/<folder>/<marker>`.
// Returns the store dir, or '' on exhaustion (filesystem root — or the home
// directory when the walk is home-bounded; the marker AT home is still
// checked before stopping). The walk is why a store at a worktree base still
// resolves from a sub-directory of the worktree.
// ONE walk, shared by discovery and by migration. They differ only in which
// roots they accept and what they want back; duplicating the loop is how the
// two drifted apart once already (migration kept walking only the legacy root
// and so stopped finding a store the moment it relocated one). The home stop,
// the root-exhaustion guard and the marker gate live here and nowhere else.
// Returns `{ base, root }` for the nearest hit, or null when exhausted.
function walkAncestors(spec, startDir, roots) {
  const home = spec.stopsAtHome ? os.homedir() : null;
  let dir = startDir;
  for (;;) {
    for (const root of roots) {
      if (fs.existsSync(path.join(dir, root, spec.folder, spec.marker))) return { base: dir, root };
    }
    if (dir === home) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Discovery: the live root only, and it wants the store directory.
function ancestorStore(spec, startDir) {
  const hit = walkAncestors(spec, startDir, [ROOT_DIR]);
  return hit ? path.join(hit.base, hit.root, spec.folder) : '';
}

// Migration: either root — a store it has already relocated must keep
// resolving so later migrations reach it — and it wants the base directory,
// from which both the current and legacy paths are derived.
function ancestorMigrationBase(spec, startDir) {
  const hit = walkAncestors(spec, startDir, [ROOT_DIR, LEGACY_ROOT_DIR]);
  return hit ? hit.base : '';
}

// ── discovery ────────────────────────────────────────────────────────────────

function homeTiersDisabled(spec) {
  return spec.envVar !== null && process.env[spec.envVar] === '1';
}

// Active stores (those with a marker) in PRECEDENCE_ORDER, de-duplicated by
// resolved dir. The worktree tier comes from the ancestor walk starting at
// dirname(cwd) — NOT from the fixed candidate row — so nested worktree
// layouts resolve; the falsy-dir guard absorbs a walk miss ('').
function discover(spec, cwd) {
  const resolved = cwd || process.cwd();
  const projectName = projectNameOf(spec, resolved);
  const skipHome = homeTiersDisabled(spec);
  const found = [];
  const seen = new Set();

  const push = (kind, dir) => {
    if (!dir || !fs.existsSync(path.join(dir, spec.marker))) return;
    const key = path.resolve(dir);
    if (seen.has(key)) return;
    seen.add(key);
    // The shared store is cross-project, so it is never stamped with the
    // caller's projectName.
    found.push({ kind, dir, projectName: kind === 'shared' ? null : projectName });
  };

  for (const kind of PRECEDENCE_ORDER) {
    if (skipHome && HOME_TIERS.has(kind)) continue;
    if (kind === 'worktree') {
      push(kind, ancestorStore(spec, path.dirname(resolved)));
    } else {
      push(kind, tierDirOf(spec, kind, resolved, projectName));
    }
  }
  return found;
}

// ── factory ──────────────────────────────────────────────────────────────────

function createStoreDiscovery(config) {
  const spec = assertConfig(config);
  return Object.freeze({
    MARKER: spec.marker,
    FOLDER: spec.folder,
    SHARED_FOLDER: spec.sharedFolder,
    // Marketplace root every tier lives under, for callers that build a store
    // path themselves instead of going through a tier.
    ROOT_DIR,
    // Pre-ROOT_DIR root, exposed for store migrations only.
    LEGACY_ROOT_DIR,
    PRECEDENCE_ORDER,
    safeExec,
    getRepoRoot,
    getProjectName: (cwd) => projectNameOf(spec, cwd),
    candidateStores: (cwd, projectName) => candidateRows(spec, cwd, projectName),
    migrationCandidates: (cwd) => migrationRows(spec, cwd || process.cwd()),
    findAncestorStore: (startDir) => ancestorStore(spec, startDir),
    discoverStores: (cwd) => discover(spec, cwd),
  });
}

module.exports = { createStoreDiscovery };
