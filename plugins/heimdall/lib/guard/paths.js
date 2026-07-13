'use strict';

/**
 * Path helpers shared across the guard engine: temp-path detection, home
 * expansion, and matching resolved paths against config-built entries.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Anchored single-token home expansion (~, $HOME, ${HOME} at start-of-string
// only) — correct for an extracted path token, unlike the free-text global
// expandHomePaths below.
const { expandHome } = require('../pathSafe');

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

/**
 * Free-text scanner over an arbitrary command string: globally replaces EVERY
 * `~` / `$HOME` / `${HOME}` occurrence, anywhere in the text (even mid-word),
 * so protected-entry matching sees home-relative references no matter where
 * they appear in a command. Deliberately NOT converged on the vendored
 * pathSafe.expandHome (GH-686/GH-582): that helper is anchored (start-of-string
 * only), and anchoring here would weaken the guard — mid-string references
 * like `cat $HOME/.claude/settings.json` would stop matching protected
 * entries. Single-path callers should use pathSafe.expandHome; this stays
 * intentionally lossy because it feeds substring matching, not path resolution.
 */
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

// ─── GH-642 boundary helpers (moved from bash.js so every lane shares them) ──

/**
 * Does `marker` appear in `text` sitting on a path-like boundary? The marker is
 * regex-escaped (same escape as the cp/rsync read check in bash.js) and must be
 * preceded by start-of-string, `/`, whitespace, a quote, or `>`, and followed
 * by end-of-string, `/`, whitespace, a quote, or `.`.
 *
 * The `>` leading boundary covers no-space redirect-writes (`>ui/x`). A second
 * alternative (`=marker/`) covers `flag=path` writes such as dd's
 * `of=src/output.dat`, where the marker is preceded by `=`.
 */
const _boundaryCache = new Map();
function getBoundaryPattern(marker) {
  if (_boundaryCache.has(marker)) return _boundaryCache.get(marker);
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Leading boundary also accepts `>` so a no-space redirect into the protected
  // dir (`>ui/x`) stays blocked — a genuine path-token write, fail-closed like
  // its spaced form `> ui/x`. See GH-642.
  //
  // The `=${esc}/` alternative restores blocking of `flag=path` writes (dd's
  // `of=src/output.dat`) that String.includes caught before the boundary anchor.
  // It requires a trailing `/` so it only fires on a path INTO the protected dir
  // — a bare assignment like `x=ui` (marker at end, no `/`) is not a path token
  // and must stay allowed. See GH-642.
  const pattern = new RegExp(`(?:^|[/\\s"'>])${esc}(?:$|[/\\s"'.])|=${esc}/`);
  _boundaryCache.set(marker, pattern);
  return pattern;
}

function markerOnPathBoundary(marker, text) {
  return getBoundaryPattern(marker).test(text);
}

// ─── GH-689: foreign-path token classifier ───────────────────────────────────
// Basename markers collide with same-named dirs elsewhere on the machine: a
// lock on <repo>/.claude must not match the agent toolchain under the user's
// HOME config dir (~/.claude/plugins/cache/**) — or any other foreign absolute
// path. Each marker occurrence is classified by resolving the path token
// around it (pathSegmentAt): only affirmative proof of foreignness exempts;
// everything resolution cannot see through stays fail-closed.

/** Dynamic/glob/backtick characters static resolution cannot see through. */
const UNRESOLVABLE_TOKEN_RE = /[$*?`]/;

/** `flag=path` tokens (dd `of=/x`, curl `--output=~/x`): classify the rooted tail. */
function stripFlagAssignment(token, marker) {
  const eq = token.lastIndexOf('=', token.indexOf(marker));
  if (eq === -1) return token;
  const tail = token.slice(eq + 1);
  return tail.startsWith('/') || tail.startsWith('~') ? tail : token;
}

/** `p` is `dir` itself or nested under it. */
function underDir(p, dir) {
  return p === dir || p.startsWith(dir + path.sep);
}

/**
 * Clause 1 — foreign-home short-circuit: a token under the home config dir
 * never matches a lock rooted elsewhere; protecting home .claude still works
 * via its own entry, matched by prefix in clause 3. See GH-689.
 */
function isForeignHomeToken(token, entry) {
  const homeConfig = path.join(os.homedir(), '.claude');
  return underDir(token, homeConfig) && !underDir(entry.dir, homeConfig);
}

function tokenIsForeignPath(rawToken, marker, entry) {
  const token = expandHome(stripFlagAssignment(rawToken, marker));
  if (UNRESOLVABLE_TOKEN_RE.test(token)) return false;
  if (!path.isAbsolute(token)) return false;
  if (isForeignHomeToken(token, entry)) return true;
  // Clause 2 — temp scratch paths are never the protected target (GH-658 parity).
  if (isTempPath(token)) return true;
  // Clause 3 — absolute resolution: foreign only when the resolved token is
  // neither entry.dir, nor under it, nor an ancestor of it (parent-dir write).
  const resolved = resolvePathSafe(token);
  // An absolute token whose FIRST segment is the marker (`/.claude/x`) is a
  // concatenation fragment glued onto a runtime base, not a root path.
  if (underDir(resolved, path.sep + marker)) return false;
  if (underDir(resolved, entry.dir)) return false;
  if (entry.dir.startsWith(resolved + path.sep)) return false;
  return true;
}

/**
 * True only when `marker` occurs in `text` AND every occurrence sits inside a
 * foreign path token, classified in clause order:
 *   1. foreign-home short-circuit — token under `$HOME/.claude` never matches
 *      a lock rooted elsewhere (protecting home .claude works via its own
 *      entry, matched by prefix);
 *   2. temp path — scratch space is never the protected target (GH-658);
 *   3. absolute resolution — a statically-clean absolute token whose
 *      `resolvePathSafe` result is neither `entry.dir`, under it, nor an
 *      ancestor of it is foreign;
 *   4. fail-closed default — relative tokens, `$VAR`/backtick/glob-bearing
 *      tokens, bare markers, and concatenation fragments are references.
 * Returns false when the marker does not occur (no affirmative proof, no
 * exemption). Symlink direction guarantee: clause 3 resolves through
 * symlinks, so a foreign-side symlink pointing INTO the protected dir still
 * realpath-resolves under `entry.dir` and stays a reference — resolution can
 * only prove foreignness, never hide a protected target.
 */
function markerOnlyInForeignPaths(text, marker, entry) {
  let idx = 0;
  let found = false;
  while ((idx = text.indexOf(marker, idx)) !== -1) {
    found = true;
    const token = pathSegmentAt(text, idx, marker.length);
    if (!tokenIsForeignPath(token, marker, entry)) return false;
    idx += marker.length;
  }
  return found;
}

/**
 * Boundary floor for free-text marker hits: markers containing `/` keep the
 * raw substring semantics (bash.js markerPresent parity — path-qualified
 * relative refs like `config/settings.json`); bare basenames must sit on a
 * path boundary (GH-642 semantics extended beyond the bash lane), killing
 * mid-word hits like `myproject.clauderc`. Task inputs arrive JSON-stringified:
 * the `"` quoting counts as a boundary via `isPathBoundary`, so quoted path
 * tokens still terminate cleanly for `pathSegmentAt` extraction.
 */
function markerOccurs(expanded, marker) {
  if (marker.includes('/')) return expanded.includes(marker);
  return markerOnPathBoundary(marker, expanded);
}

function textReferencesEntry(expanded, entry) {
  if (expanded.includes(entry.dir)) return true;
  for (const marker of entry.markers) {
    if (!markerOccurs(expanded, marker)) continue;
    // GH-689: a text naming only foreign paths does not reference the entry.
    if (!markerOnlyInForeignPaths(expanded, marker, entry)) return true;
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
  getBoundaryPattern,
  markerOnPathBoundary,
  markerOnlyInForeignPaths,
  textReferencesEntry,
  findProtectedPathRef,
  findProtectedPathRefs,
  findProtectedTarget,
  resolvePathSafe,
  allRefsUnderAllowedPaths,
};
