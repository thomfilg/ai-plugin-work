'use strict';

/**
 * Heimdall lock-store discovery + config IO.
 *
 * Mirrors synapsys's store model: a store lives at `.claude/heimdall/` and is
 * identified by a `.heimdall.json` marker. Unlike synapsys (one markdown file
 * per memory), heimdall keeps everything in the marker itself — the marker IS
 * the config and holds the `locks` array.
 *
 * Four store kinds (see `PRECEDENCE_ORDER`):
 *   local    → <cwd>/.claude/heimdall
 *   worktree → nearest ancestor above cwd carrying the marker
 *   global   → ~/.claude/heimdall/<projectName>
 *   shared   → ~/.claude/heimdall-shared  (user-wide across every project)
 *
 * Locks discovered across all active stores are merged; on conflict the
 * earlier kind in `PRECEDENCE_ORDER` (local > worktree > global > shared)
 * wins.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const MARKER = '.heimdall.json';
const FOLDER = 'heimdall';
const SHARED_FOLDER = `${FOLDER}-shared`;
const SCHEMA_VERSION = 1;
// Documented lock-merge precedence (GH-541 R4): when the same path is
// protected in multiple stores, earlier kinds win. `discoverStores` returns
// active stores in this order, and downstream merge/scan/list consumers
// align on this constant rather than hand-rolling string literals.
const PRECEDENCE_ORDER = Object.freeze(['local', 'worktree', 'global', 'shared']);

// jscpd:ignore-start
// The store-discovery primitives below intentionally mirror synapsys's
// memory-store.js: heimdall reuses the same local/worktree/global store model
// on purpose, but must stay a self-contained plugin (it is installed
// independently and cannot require synapsys at runtime). The duplication is
// therefore deliberate and is excluded from the duplicate-blocks gate.
function safeExec(cmd, cwd) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** Git toplevel of cwd, or cwd itself when not in a repo. */
function getRepoRoot(cwd) {
  const resolvedCwd = cwd || process.cwd();
  const top = safeExec('git rev-parse --show-toplevel', resolvedCwd);
  return top || resolvedCwd;
}

function getProjectName(cwd) {
  return path.basename(getRepoRoot(cwd));
}

function candidateStores(cwd, projectName) {
  return [
    { kind: 'local', dir: path.join(cwd, '.claude', FOLDER) },
    { kind: 'worktree', dir: path.resolve(cwd, '..', '.claude', FOLDER) },
    { kind: 'global', dir: path.join(os.homedir(), '.claude', FOLDER, projectName) },
    { kind: 'shared', dir: path.join(os.homedir(), '.claude', SHARED_FOLDER) },
  ];
}

/**
 * Walk up from startDir to the nearest ancestor carrying a store marker at
 * `<ancestor>/.claude/heimdall/.heimdall.json`. Returns the store dir or ''.
 * (Same rationale as synapsys: sessions may run from a sub-directory of a
 * worktree whose shared store sits at the worktree base.)
 *
 * Stops AFTER checking the user's HOME directory: a `--kind=worktree` install
 * from a repo directly under home writes its marker to `~/.claude/heimdall`
 * via `candidateStores`, and that legitimate worktree marker must remain
 * discoverable. The walk does not continue past HOME so sandboxed e2e tests
 * (whose tmp HOME is set via $HOME env) cannot leak the real user's marker
 * into the test session.
 */
function findAncestorStore(startDir) {
  const home = os.homedir();
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.claude', FOLDER, MARKER))) {
      return path.join(dir, '.claude', FOLDER);
    }
    if (dir === home) return '';
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
}

/** Active stores (those with a marker) in precedence order, de-duplicated. */
function discoverStores(cwd) {
  const resolved = cwd || process.cwd();
  const projectName = getProjectName(resolved);
  const out = [];
  const seen = new Set();

  const push = (kind, dir) => {
    if (!dir) return;
    const key = path.resolve(dir);
    if (seen.has(key)) return;
    if (!fs.existsSync(path.join(dir, MARKER))) return;
    seen.add(key);
    // The shared store is cross-project, so it must not be stamped with the
    // caller's projectName (mirrors the marker written by heimdall-init.js).
    out.push({ kind, dir, projectName: kind === 'shared' ? null : projectName });
  };

  // Build a kind→dir map from the canonical candidate list so the loop below
  // mirrors PRECEDENCE_ORDER without duplicating literal kind strings.
  const candidateMap = Object.fromEntries(
    candidateStores(resolved, projectName).map((c) => [c.kind, c.dir])
  );

  // Walk PRECEDENCE_ORDER as the single source of truth. Reordering or
  // extending PRECEDENCE_ORDER automatically reorders this discovery output;
  // adding a new kind only requires extending candidateStores.
  for (const kind of PRECEDENCE_ORDER) {
    if (kind === 'worktree') {
      // worktree has bespoke discovery (ancestor walk) — the candidateMap
      // entry is only used by --kind=worktree installs that drop a marker at
      // the parent .claude/heimdall directly. Discovery prefers the nearest
      // ancestor carrying a marker, which can be that same path or higher.
      const wt = findAncestorStore(path.dirname(resolved));
      if (wt) push('worktree', wt);
      continue;
    }
    push(kind, candidateMap[kind]);
  }

  return out;
}
// jscpd:ignore-end

function readConfig(storeDir) {
  try {
    const raw = fs.readFileSync(path.join(storeDir, MARKER), 'utf8');
    const cfg = JSON.parse(raw);
    if (!Array.isArray(cfg.locks)) cfg.locks = [];
    return cfg;
  } catch {
    return null;
  }
}

function writeConfig(storeDir, cfg) {
  fs.mkdirSync(storeDir, { recursive: true });
  const out = { schemaVersion: SCHEMA_VERSION, ...cfg };
  fs.writeFileSync(path.join(storeDir, MARKER), `${JSON.stringify(out, null, 2)}\n`);
}

/**
 * Add a lock block (or merge paths into the existing block with the same
 * phrase). Mutates cfg.locks and returns the resulting block.
 */
function upsertLock(cfg, { phrase, paths, allowedPaths, trustedSubdirs }) {
  const existing = cfg.locks.find((l) => (l.unlockPhrase || '').trim() === phrase);
  const block = existing || { protect: [], unlockPhrase: phrase };
  block.protect = [...new Set([...(block.protect || []), ...paths])];
  if (allowedPaths) block.allowedPaths = allowedPaths;
  if (trustedSubdirs) block.trustedSubdirs = trustedSubdirs;
  if (!existing) cfg.locks.push(block);
  return block;
}

/**
 * Remove a lock block by phrase, or just `paths` from it (deleting the block if
 * it becomes empty). Returns a status: 'missing' | 'removed' | 'emptied' | 'trimmed'.
 */
function removeLock(cfg, phrase, paths = []) {
  const idx = cfg.locks.findIndex((l) => (l.unlockPhrase || '').trim() === phrase);
  if (idx === -1) return 'missing';
  if (paths.length === 0) {
    cfg.locks.splice(idx, 1);
    return 'removed';
  }
  const block = cfg.locks[idx];
  block.protect = (block.protect || []).filter((p) => !paths.includes(p));
  if (block.protect.length === 0) {
    cfg.locks.splice(idx, 1);
    return 'emptied';
  }
  return 'trimmed';
}

module.exports = {
  MARKER,
  FOLDER,
  SHARED_FOLDER,
  SCHEMA_VERSION,
  PRECEDENCE_ORDER,
  safeExec,
  getRepoRoot,
  getProjectName,
  candidateStores,
  findAncestorStore,
  discoverStores,
  readConfig,
  writeConfig,
  upsertLock,
  removeLock,
};
