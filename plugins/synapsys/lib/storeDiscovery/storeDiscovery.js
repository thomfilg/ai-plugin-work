// GENERATED — edit factories/storeDiscovery/storeDiscovery.js and run scripts/sync-vendored.js

'use strict';

/**
 * storeDiscovery — factory for tiered, marker-gated store discovery.
 *
 * Plugins persist per-project artifacts in a "store": a directory under
 * `.claude/<folder>` gated by a marker file, so only explicitly installed
 * locations are ever read. Stores are discovered across four tiers and
 * returned in a fixed precedence order:
 *
 *   local    → <cwd>/.claude/<folder>
 *   worktree → nearest ancestor above cwd carrying the marker
 *   global   → ~/.claude/<folder>/<projectName>
 *   shared   → ~/.claude/<folder>-shared   (cross-project)
 *
 * The decision matrix IS the config:
 *
 * - `folder` / `marker` name the store directory and its gate file. The
 *   shared tier always lives at `<folder>-shared`, a SIBLING of the
 *   per-project namespace, so a project whose name happens to match the
 *   shared folder can never shadow it.
 * - `projectNameStrategy` picks how the global tier derives its name.
 *   'git-common-dir' prefers the git common dir so a linked worktree
 *   resolves to the MAIN repo name (the common dir is `<main>/.git` for the
 *   main checkout and every linked worktree), falling back to the toplevel
 *   basename, then basename(cwd). 'toplevel' is basename(toplevel || cwd).
 * - `ancestorWalkStopsAtHome` bounds the worktree ancestor walk. When true,
 *   each directory's marker is checked FIRST and the walk then stops at the
 *   user's home directory: a marker AT `$HOME/.claude/<folder>` stays
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
const CLAUDE_DIR = '.claude';

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

// Canonical directory for one tier. os.homedir() is deliberately read here,
// at call time, so a reassigned $HOME is honored per call.
function tierDirOf(spec, kind, cwd, projectName) {
  switch (kind) {
    case 'local':
      return path.join(cwd, CLAUDE_DIR, spec.folder);
    case 'worktree':
      return path.resolve(cwd, '..', CLAUDE_DIR, spec.folder);
    case 'global':
      return path.join(os.homedir(), CLAUDE_DIR, spec.folder, projectName);
    case 'shared':
      return path.join(os.homedir(), CLAUDE_DIR, spec.sharedFolder);
    default:
      return '';
  }
}

function candidateRows(spec, cwd, projectName) {
  return PRECEDENCE_ORDER.map((kind) => ({ kind, dir: tierDirOf(spec, kind, cwd, projectName) }));
}

// ── ancestor walk ────────────────────────────────────────────────────────────

// Nearest ancestor of startDir carrying `<ancestor>/.claude/<folder>/<marker>`.
// Returns the store dir, or '' on exhaustion (filesystem root — or the home
// directory when the walk is home-bounded; the marker AT home is still
// checked before stopping). The walk is why a store at a worktree base still
// resolves from a sub-directory of the worktree.
function ancestorStore(spec, startDir) {
  const home = spec.stopsAtHome ? os.homedir() : null;
  let dir = startDir;
  for (;;) {
    const storeDir = path.join(dir, CLAUDE_DIR, spec.folder);
    if (fs.existsSync(path.join(storeDir, spec.marker))) return storeDir;
    if (dir === home) return '';
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
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
    PRECEDENCE_ORDER,
    safeExec,
    getRepoRoot,
    getProjectName: (cwd) => projectNameOf(spec, cwd),
    candidateStores: (cwd, projectName) => candidateRows(spec, cwd, projectName),
    findAncestorStore: (startDir) => ancestorStore(spec, startDir),
    discoverStores: (cwd) => discover(spec, cwd),
  });
}

module.exports = { createStoreDiscovery };
