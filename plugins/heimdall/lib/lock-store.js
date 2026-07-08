'use strict';

/**
 * Heimdall lock-store discovery + config IO.
 *
 * A store lives at `.claude/heimdall/` and is identified by a `.heimdall.json`
 * marker. Unlike synapsys (one markdown file per memory), heimdall keeps
 * everything in the marker itself — the marker IS the config and holds the
 * `locks` array.
 *
 * Tiered store discovery (local/worktree/global/shared, marker gating,
 * precedence, HOME-bounded ancestor walk) is delegated to the vendored
 * storeDiscovery factory; this module layers heimdall's config IO and
 * lock-block editing on top.
 *
 * Locks discovered across all active stores are merged; on conflict the
 * earlier kind in `PRECEDENCE_ORDER` (local > worktree > global > shared)
 * wins (GH-541 R4). Downstream merge/scan/list consumers align on the
 * exported constant rather than hand-rolling string literals.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createStoreDiscovery } = require('./storeDiscovery');

const SCHEMA_VERSION = 1;

const discovery = createStoreDiscovery({
  folder: 'heimdall',
  marker: '.heimdall.json',
  // Heimdall's historical project naming: basename(git toplevel || cwd).
  projectNameStrategy: 'toplevel',
  // A `--kind=worktree` install from a repo directly under home writes its
  // marker to `~/.claude/heimdall`; that legitimate marker stays discoverable,
  // but the ancestor walk never continues PAST home, so sandboxed e2e tests
  // (whose tmp HOME is set via $HOME) cannot leak the real user's marker into
  // the test session.
  ancestorWalkStopsAtHome: true,
  disableHomeStoresEnvVar: null,
});

const { MARKER } = discovery;

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
  // Discovery surface, bound to heimdall's folder/marker by the factory
  // instance above. getRepoRoot and findAncestorStore ARE part of heimdall's
  // public surface — scan.js, hooks/heimdall.js and heimdall-list.js use them.
  MARKER,
  FOLDER: discovery.FOLDER,
  SHARED_FOLDER: discovery.SHARED_FOLDER,
  SCHEMA_VERSION,
  PRECEDENCE_ORDER: discovery.PRECEDENCE_ORDER,
  safeExec: discovery.safeExec,
  getRepoRoot: discovery.getRepoRoot,
  getProjectName: discovery.getProjectName,
  candidateStores: discovery.candidateStores,
  findAncestorStore: discovery.findAncestorStore,
  discoverStores: discovery.discoverStores,
  // Heimdall-specific config IO + lock-block editing.
  readConfig,
  writeConfig,
  upsertLock,
  removeLock,
};
