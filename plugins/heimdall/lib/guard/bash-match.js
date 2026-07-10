'use strict';

/**
 * Target ↔ entry matching for the structured bash analyzer (GH-699). Decides
 * whether a write-target token resolves to (or destroys) a protected entry,
 * and whether a segment's text references it (foreign-filtered).
 */

const path = require('node:path');
const {
  expandHomePaths,
  markerOnPathBoundary,
  markerOnlyInForeignPaths,
  resolvePathSafe,
} = require('./paths');
const {
  commandGlobReferencesMarker,
  commandGlobReferencesPath,
  reduceSingleCharClasses,
} = require('./shell-normalize');
const { expandHome } = require('../pathSafe');
const { SUBST_RE } = require('./bash-scan');

function tokenNamesEntry(token, entry) {
  const texts = [token.dq.replace(SUBST_RE, ''), expandHomePaths(token.raw)];
  for (const s of texts) {
    if (s.includes(entry.dir)) return true;
    for (const marker of entry.markers) {
      if (marker.includes('/') ? s.includes(marker) : markerOnPathBoundary(marker, s)) return true;
    }
  }
  return false;
}

/** Longest literal directory prefix of a glob-bearing path. */
function literalGlobPrefix(p) {
  const idx = p.search(/[*?[]/);
  if (idx === -1) return p;
  const cut = p.lastIndexOf('/', idx);
  return cut === -1 ? '' : p.slice(0, cut);
}

function isInAllowedSubdir(entry, resolved) {
  if (entry.isFile || !entry.allowedPaths) return false;
  const rel = path.relative(entry.dir, resolved);
  const first = rel.split(path.sep)[0];
  return Boolean(first) && first !== '..' && entry.allowedPaths.includes(first);
}

/** A resolved literal path → 'hit' when it is (under) the entry, else 'miss'. */
function literalTargetVerdict(literal, entry, segCwd) {
  if (!literal || literal === '-') return 'miss';
  const abs = path.isAbsolute(literal) ? literal : path.resolve(segCwd, literal);
  const resolved = resolvePathSafe(abs);
  if (resolved === entry.dir || resolved.startsWith(entry.dir + path.sep)) {
    return isInAllowedSubdir(entry, resolved) ? 'miss' : 'hit';
  }
  return 'miss';
}

/** Glob token → 'hit'/'miss' via glob-reference machinery + prefix resolution. */
function globTargetVerdict(token, entry, segCwd, reduced) {
  if (commandGlobReferencesPath(token.dq, entry.dir)) return 'hit';
  for (const marker of entry.markers) {
    if (!marker.includes('/') && commandGlobReferencesMarker(token.dq, marker)) return 'hit';
  }
  const prefix = literalGlobPrefix(reduced);
  if (!prefix) return tokenNamesEntry(token, entry) ? 'hit' : 'miss';
  const abs = path.isAbsolute(prefix) ? prefix : path.resolve(segCwd, prefix);
  const resolved = resolvePathSafe(abs);
  return resolved === entry.dir || resolved.startsWith(entry.dir + path.sep) ? 'hit' : 'miss';
}

/**
 * Does a write-target token hit the entry? Returns 'hit' | 'miss'.
 * Unresolvable tokens ($VAR/$(…)/unknown cwd) hit only when they NAME the
 * entry — same trigger contract as the legacy matcher (fires only on named
 * refs), just scoped to genuine write operands.
 */
function targetVerdict(token, entry, segCwd) {
  if (token.hasSubst || segCwd === null) {
    return tokenNamesEntry(token, entry) ? 'hit' : 'miss';
  }
  const dq = expandHome(expandHomePaths(token.dq));
  if (token.hasGlob) {
    // A single-char class ([l]) is exactly one literal (GH-655): reduce and
    // resolve it, so an obfuscated FOREIGN path is exonerated by resolution
    // while an obfuscated protected path still hits.
    const reduced = reduceSingleCharClasses(dq);
    if (!/[*?[]/.test(reduced)) return literalTargetVerdict(reduced, entry, segCwd);
    return globTargetVerdict(token, entry, segCwd, reduced);
  }
  return literalTargetVerdict(dq, entry, segCwd);
}

/** `rm -rf <dir-above-entry>` (spelled via the entry) destroys the entry too. */
function ancestorHit(token, entry, segCwd) {
  if (token.hasSubst || token.hasGlob || segCwd === null) return false;
  const dq = expandHome(expandHomePaths(token.dq));
  if (!dq || dq === '-') return false;
  const abs = path.isAbsolute(dq) ? dq : path.resolve(segCwd, dq);
  return entry.dir.startsWith(resolvePathSafe(abs) + path.sep);
}

/** Does the segment text reference the entry (boundary + foreign-filtered)? */
function segmentReferencesEntry(seg, entry) {
  const text = expandHomePaths(
    seg.tokens
      .concat(seg.redirects.map((r) => r.target))
      .map((t) => t.dq.replace(SUBST_RE, '$'))
      .join(' ')
  );
  if (text.includes(entry.dir)) return true;
  for (const marker of entry.markers) {
    const occurs = marker.includes('/')
      ? text.includes(marker)
      : markerOnPathBoundary(marker, text);
    if (occurs && !markerOnlyInForeignPaths(text, marker, entry)) return true;
  }
  return false;
}

module.exports = {
  targetVerdict,
  ancestorHit,
  segmentReferencesEntry,
  tokenNamesEntry,
};
