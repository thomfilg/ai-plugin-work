'use strict';

/**
 * scope-markers.js — the ONE definition of the documented scope annotations.
 *
 * `tasks.md` scope entries may carry a trailing marker declaring that a path is
 * not yet (or no longer) on disk:
 *
 *     - `components/ui/sparkline/** (NEW)`
 *     - `lib/legacy/old-helper.ts (DELETE)`
 *
 * `scope_exists` REQUIRES the marker on a file that does not exist yet, so any
 * consumer that treats a scope entry as a path MUST strip it first. A parser
 * that forgets hands the gate a path that can never resolve, making its
 * conditions unsatisfiable no matter how sound the work is (GH-725 class).
 *
 * This module exists because that bug has now been fixed independently three
 * times, each with its own private regex — and one of those copies covered only
 * `(NEW)`, so `(DELETE)` silently slipped through. Every consumer imports from
 * here; nobody re-derives the pattern.
 */

/**
 * Anchored form, for a scope ENTRY (one path).
 *
 * Anchoring at end-of-entry is deliberate. The marker is documented to trail
 * the path, so an occurrence in the MIDDLE of an entry is malformed input.
 * Stripping that silently would hide the authoring mistake while still yielding
 * a path that does not resolve — strictly worse than leaving it in place, where
 * the scope gate reports it. Free-form prose uses the global form below.
 */
const SCOPE_MARKER_RE = /\s*\((?:NEW|DELETE)\)\s*$/i;

/** Unanchored form, for prose that may name several files on one line. */
const SCOPE_MARKER_GLOBAL_RE = /\s*\((?:NEW|DELETE)\)\s*/gi;

/**
 * Strip a trailing marker from ONE scope entry.
 *
 * @param {string} entry
 * @returns {string} the entry without its marker, trimmed
 */
function stripScopeMarker(entry) {
  return String(entry).replace(SCOPE_MARKER_RE, '').trim();
}

/**
 * Strip the marker from every entry of a scope list, dropping empties.
 *
 * @param {string[]|null|undefined} scopeGlobs
 * @returns {string[]}
 */
function normalizeScope(scopeGlobs) {
  return (scopeGlobs || []).map(stripScopeMarker).filter(Boolean);
}

/**
 * Strip EVERY marker occurrence from free text.
 *
 * Each match collapses to a single space rather than being deleted, so tokens
 * either side of a marker do not fuse: `a.ts (NEW) b.ts` -> `a.ts b.ts`.
 *
 * @param {string} text
 * @returns {string}
 */
function stripScopeMarkersInText(text) {
  return String(text).replace(SCOPE_MARKER_GLOBAL_RE, ' ').trim();
}

module.exports = {
  SCOPE_MARKER_RE,
  SCOPE_MARKER_GLOBAL_RE,
  stripScopeMarker,
  normalizeScope,
  stripScopeMarkersInText,
};
