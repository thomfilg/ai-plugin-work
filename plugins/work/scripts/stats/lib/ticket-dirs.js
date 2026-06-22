/**
 * ticket-dirs.js — direct-child ticket-dir lister with a path-traversal guard.
 *
 * Lists the immediate child directories of TASKS_BASE (resolved exclusively via
 * `getConfig`, never ad-hoc process.env access). This is the aggregation reader
 * used by `/stats all` and the orphan scan in `/health`.
 *
 * Security: each candidate is resolved with `path.resolve` and rejected unless
 * it stays strictly contained within TASKS_BASE, so `..` names and symlinks
 * whose targets escape the base are excluded (GH-317 / R15).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const getConfig = require('../../workflows/lib/get-config');

/**
 * Is `child` strictly contained within `base` after symlink resolution?
 * @param {string} base - absolute, canonicalized base directory.
 * @param {string} childName - bare dirent name to test against `base`.
 * @returns {boolean} true when the resolved child lives inside `base`.
 */
function isContained(base, childName) {
  const candidate = path.resolve(base, childName);
  let resolved;
  try {
    resolved = fs.realpathSync(candidate);
  } catch (_err) {
    return false;
  }
  const rel = path.relative(base, resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Predicate: does this dirent represent a usable direct-child ticket dir?
 * Accepts real directories and directory symlinks; the containment check in
 * `listTicketDirs` rejects symlinks that escape the base.
 * @param {fs.Dirent} dirent
 * @returns {boolean}
 */
function isTicketDirent(dirent) {
  return dirent.isDirectory() || dirent.isSymbolicLink();
}

/**
 * List the direct-child ticket directories under TASKS_BASE.
 *
 * Return contract: an array of bare directory names (no path separators, no
 * `..`), each a direct child of TASKS_BASE whose resolved path stays contained
 * within TASKS_BASE. Regular files, nested descendants, and traversal-escaping
 * symlinks are excluded. Returns `[]` when TASKS_BASE is unset or unreadable.
 *
 * @returns {string[]} sorted-as-read ticket directory names.
 */
function listTicketDirs() {
  const base = getConfig('TASKS_BASE');
  if (!base) return [];

  let canonicalBase;
  let dirents;
  try {
    canonicalBase = fs.realpathSync(base);
    dirents = fs.readdirSync(canonicalBase, { withFileTypes: true });
  } catch (_err) {
    return [];
  }

  return dirents
    .filter(isTicketDirent)
    .map((d) => d.name)
    .filter((name) => isContained(canonicalBase, name));
}

module.exports = { listTicketDirs };
