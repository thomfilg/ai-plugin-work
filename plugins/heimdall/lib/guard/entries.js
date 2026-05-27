'use strict';

/**
 * Build guard "entries" from lock blocks.
 *
 * A lock block is the tuple { protect: [<dir|file>, ...], unlockPhrase }.
 * Each protect path becomes an entry { dir, isFile, markers, unlockPhrase,
 * allowedPaths, trustedSubdirs }, with entries from the same block sharing the
 * block's unlock phrase.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function expandHome(p) {
  if (!p) return p;
  return p
    .replace(/^~(?=\/|$)/, os.homedir())
    .replace(/^\$HOME(?=\/|$)/, os.homedir())
    .replace(/^\$\{HOME\}(?=\/|$)/, os.homedir());
}

/**
 * Decide whether a path denotes a file or directory. Prefer the real
 * filesystem; otherwise infer: a basename with a char before a dotted
 * extension (package.json) is a file; dotfiles (.claude) and extensionless
 * names are directories.
 */
function looksLikeFile(absPath) {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return /[^.].*\.[A-Za-z0-9]+$/.test(path.basename(absPath));
  }
}

function markersFor(raw, absPath) {
  const markers = new Set([path.basename(absPath)]);
  if (raw.includes('/')) {
    markers.add(raw.replace(/^~\/?/, '').replace(/^\$\{?HOME\}?\/?/, ''));
  }
  return [...markers].filter(Boolean);
}

function buildEntry(raw, lock, baseDir) {
  const expanded = expandHome(raw.trim());
  const abs = path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(baseDir, expanded);
  return {
    dir: abs,
    isFile: looksLikeFile(abs),
    markers: markersFor(raw, abs),
    unlockPhrase: String(lock.unlockPhrase || '').trim(),
    allowedPaths: Array.isArray(lock.allowedPaths) ? lock.allowedPaths : null,
    trustedSubdirs: Array.isArray(lock.trustedSubdirs) ? lock.trustedSubdirs : [],
  };
}

/** Build engine entries from lock blocks, resolving relative paths to baseDir. */
function buildEntries(locks, baseDir) {
  const entries = [];
  if (!Array.isArray(locks)) return entries;
  for (const lock of locks) {
    if (!lock || typeof lock !== 'object') continue;
    const protect = Array.isArray(lock.protect) ? lock.protect : [];
    for (const raw of protect) {
      if (raw && typeof raw === 'string') entries.push(buildEntry(raw, lock, baseDir));
    }
  }
  return entries;
}

module.exports = { expandHome, looksLikeFile, buildEntries };
