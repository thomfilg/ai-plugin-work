'use strict';

/**
 * Scan logic for the install flow — kept in lib (not the CLI script) so it can
 * be unit-tested in-process without spawning a subprocess.
 *
 * Walks the default catalog and keeps only targets that actually EXIST:
 *   - 'repo' targets are resolved against the repo root and must exist there.
 *   - 'home' targets are resolved against the home dir and are suggested only
 *     for a `global` install (a home path is not "in the repository").
 * Targets already covered by an existing lock in the active store(s) are
 * dropped, so re-running install never re-suggests what's already protected.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CATALOG } = require('./catalog');
const { getRepoRoot, discoverStores, readConfig } = require('./lock-store');
const { buildEntries } = require('./guard');

function resolveTarget(target, repoRoot) {
  if (target.anchor === 'home') {
    return path.join(os.homedir(), target.path.replace(/^~\/?/, ''));
  }
  return path.resolve(repoRoot, target.path);
}

/** Absolute paths already protected by any active store. */
function alreadyProtected(cwd, repoRoot) {
  const protectedAbs = new Set();
  for (const store of discoverStores(cwd)) {
    const cfg = readConfig(store.dir);
    if (!cfg) continue;
    for (const entry of buildEntries(cfg.locks, repoRoot)) protectedAbs.add(entry.dir);
  }
  return protectedAbs;
}

/**
 * Decide whether a target's anchor surfaces for a given install kind.
 *   - home-anchored targets surface for `global` and `shared`
 *   - repo-anchored targets surface for `local|worktree|global` (not `shared`)
 */
function isSurfacedForKind(anchor, kind) {
  if (kind === 'shared') return anchor === 'home';
  if (anchor === 'home') return kind === 'global';
  return true;
}

function suggestionFor(item, kind, repoRoot, protectedAbs) {
  const protect = [];
  for (const target of item.targets) {
    if (!isSurfacedForKind(target.anchor, kind)) continue;
    const abs = resolveTarget(target, repoRoot);
    if (!fs.existsSync(abs)) continue;
    if (protectedAbs.has(abs)) continue;
    protect.push(target.path);
  }
  if (protect.length === 0) return null;
  const suggestion = {
    id: item.id,
    label: item.label,
    description: item.description,
    defaultPhrase: item.defaultPhrase,
    protect,
  };
  if (item.allowedPaths) suggestion.allowedPaths = item.allowedPaths;
  if (item.trustedSubdirs) suggestion.trustedSubdirs = item.trustedSubdirs;
  return suggestion;
}

/** Compute install suggestions for { cwd, kind }. */
function scan({ cwd, kind }) {
  const repoRoot = getRepoRoot(cwd);
  const protectedAbs = alreadyProtected(cwd, repoRoot);
  const suggestions = [];
  for (const item of CATALOG) {
    const s = suggestionFor(item, kind, repoRoot, protectedAbs);
    if (s) suggestions.push(s);
  }
  return suggestions;
}

module.exports = { scan };
