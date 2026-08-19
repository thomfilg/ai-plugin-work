'use strict';

/**
 * repo-path.js — canonicalize a repo-relative path for comparison against
 * git's `--name-only` output.
 *
 * Extracted from `work-completion-checker/lib/phases/reuse_audit_enforcement.js`
 * (GH-607) so the normalisation contract lives in one documented, testable
 * place rather than inline in a file pinned at its max-lines cap.
 */

/**
 * Canonicalize a repo-relative path.
 *
 * Spec-declared spellings (`./hooks.json`, `foo//bar.json`, a leading `/`) are
 * folded onto the shape git reports. Conservative on purpose: a `..` segment is
 * left intact, so an out-of-tree path can never silently normalize onto a
 * matching in-tree one.
 *
 * A trailing `:58` / `:58:12` location suffix is also stripped. Spec reuse
 * declarations cite a line, and leaving that attached breaks BOTH consumers of
 * a declared path:
 *
 *   - `path.extname('sidebar.tsx:58')` returns `'.tsx:58'`, which is in no
 *     extension set, so an importable module is misrouted to the config-file
 *     branch and matched by a `git diff` on a path that cannot exist; and
 *   - the changed-file lookup can never match a real file while the suffix is
 *     attached, so the entry is reported missing however present it is.
 *
 * @param {string} p
 * @returns {string} the canonical form; non-string input is returned unchanged
 */
function normalizeRepoPath(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  let out = p
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/:\d+(?::\d+)?$/, '');
  while (out.startsWith('./')) out = out.slice(2);
  return out.replace(/\/$/, '');
}

module.exports = { normalizeRepoPath };
