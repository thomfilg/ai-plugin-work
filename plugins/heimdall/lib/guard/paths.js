'use strict';

/**
 * Path helpers shared across the guard engine: temp-path detection, home
 * expansion, and matching resolved paths against config-built entries.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEMP_PREFIXES = (() => {
  const raw = new Set([os.tmpdir(), '/tmp', '/var/tmp']);
  const resolved = new Set();
  for (const p of raw) {
    resolved.add(p);
    try {
      resolved.add(fs.realpathSync(p));
    } catch {
      /* ignore */
    }
  }
  return [...resolved];
})();

function isTempPath(filePath) {
  const normalized = path.resolve(filePath);
  for (const prefix of TEMP_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix + path.sep)) return true;
  }
  return false;
}

function expandHomePaths(text) {
  return text
    .replace(/~/g, os.homedir())
    .replace(/\$HOME/g, os.homedir())
    .replace(/\$\{HOME\}/g, os.homedir());
}

function isPathBoundary(c) {
  return ' \t\n\r"\'`,;()[]{}|<>'.includes(c);
}

/** Extract the path-like substring surrounding index `idx` in `text`. */
function pathSegmentAt(text, idx, markerLen) {
  let start = idx;
  while (start > 0 && !isPathBoundary(text[start - 1])) start--;
  let end = idx + markerLen;
  while (end < text.length && !isPathBoundary(text[end])) end++;
  return text.substring(start, end);
}

/** True only when every occurrence of marker sits inside a temp path. */
function markerOnlyInTempPaths(text, marker) {
  let idx = 0;
  let found = false;
  while ((idx = text.indexOf(marker, idx)) !== -1) {
    found = true;
    const segment = pathSegmentAt(text, idx, marker.length);
    if (segment.startsWith('/') && isTempPath(path.resolve(segment))) {
      idx += marker.length;
      continue;
    }
    return false;
  }
  return found;
}

function textReferencesEntry(expanded, entry) {
  if (expanded.includes(entry.dir)) return true;
  for (const marker of entry.markers) {
    if (expanded.includes(marker) && !markerOnlyInTempPaths(expanded, marker)) return true;
  }
  return false;
}

/** First entry referenced by free text (used for Task prompts), or null. */
function findProtectedPathRef(text, entries) {
  const expanded = expandHomePaths(text);
  return entries.find((entry) => textReferencesEntry(expanded, entry)) || null;
}

/** All entries referenced by free text. */
function findProtectedPathRefs(text, entries) {
  const expanded = expandHomePaths(text);
  return entries.filter((entry) => textReferencesEntry(expanded, entry));
}

/** Match a resolved absolute path against entries: file=exact, dir=prefix. */
function findProtectedTarget(normalizedPath, entries) {
  if (isTempPath(normalizedPath)) return null;
  for (const entry of entries) {
    if (entry.isFile) {
      if (normalizedPath === entry.dir) return entry;
    } else if (normalizedPath === entry.dir || normalizedPath.startsWith(entry.dir + path.sep)) {
      return entry;
    }
  }
  return null;
}

/** Resolve a path through symlinks, tolerating non-existent leaf files. */
function resolvePathSafe(filePath) {
  try {
    const resolved = path.resolve(filePath);
    try {
      return fs.realpathSync(resolved);
    } catch {
      const dir = path.dirname(resolved);
      try {
        return path.join(fs.realpathSync(dir), path.basename(resolved));
      } catch {
        return resolved;
      }
    }
  } catch {
    return path.resolve(filePath);
  }
}

/** True only when every reference to entry.dir is under an allowed subdir. */
function allRefsUnderAllowedPaths(text, entry) {
  const exemptDirs = entry.allowedPaths;
  if (!exemptDirs || exemptDirs.length === 0) return false;
  const dir = entry.dir;
  let idx = 0;
  let found = false;
  while ((idx = text.indexOf(dir, idx)) !== -1) {
    found = true;
    let end = idx + dir.length;
    while (end < text.length && !isPathBoundary(text[end])) end++;
    const fullPath = text.substring(idx, end);
    if (fullPath.length <= dir.length || fullPath[dir.length] !== '/') return false;
    const firstSegment = fullPath.substring(dir.length + 1).split('/')[0];
    if (!firstSegment || !exemptDirs.includes(firstSegment)) return false;
    idx = end;
  }
  return found;
}

module.exports = {
  isTempPath,
  expandHomePaths,
  isPathBoundary,
  markerOnlyInTempPaths,
  findProtectedPathRef,
  findProtectedPathRefs,
  findProtectedTarget,
  resolvePathSafe,
  allRefsUnderAllowedPaths,
};
