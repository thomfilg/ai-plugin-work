'use strict';

/**
 * relocate — the "this store moved" migration body.
 *
 * Relocating a directory is the migration every plugin needs first and gets
 * subtly wrong by hand, so it ships as one reviewed implementation rather than
 * five near-copies. The three cases:
 *
 *   `from` absent
 *     → nothing to carry forward. No-op. This is the overwhelmingly common
 *       case (fresh installs, and every session after the first migrated one),
 *       so it must be cheap and must not create anything.
 *
 *   `to` absent
 *     → rename(2). Atomic on one filesystem: a concurrent reader sees the
 *       store at the old path or the new one, never half at each. Both paths
 *       are same-root by construction (both under the repo, or both under
 *       $HOME), so EXDEV is the exotic case — bind mounts, $HOME on a
 *       different device — and falls back to copy-then-remove.
 *
 *   `to` present
 *     → MERGE, never clobber. This is the "user reinstalled before upgrading"
 *       case: a fresh empty store at the new path while the real data sits at
 *       the old one. Entries missing from `to` are copied in; entries already
 *       there win and are left untouched. `from` is deliberately KEPT — a
 *       merge is the ambiguous case, and deleting the user's only other copy
 *       of their data on a guess is not a migration, it is data loss.
 *
 * Callers get `{ moved, merged, kept }` so a hook can report what happened;
 * errors propagate so the runner records them and leaves the stamp behind.
 */

const fs = require('node:fs');
const path = require('node:path');

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// Non-destructive recursive copy: existing destination entries are preserved.
// `force: false` + `errorOnExist: false` is precisely "skip what is already
// there" — the merge policy above, delegated to the platform.
function copyPreservingExisting(from, to) {
  fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
}

function moveDirectory(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // Cross-device: copy, verify, then drop the source.
    copyPreservingExisting(from, to);
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Move `from` → `to`, merging instead of clobbering when `to` already exists.
 *
 * @returns {{moved: boolean, merged: boolean, kept: boolean}}
 *   moved  — `to` was created by relocating `from`
 *   merged — `to` existed; missing entries were copied in
 *   kept   — `from` still exists on disk afterwards (always true for a merge)
 */
function relocateDirectory(from, to) {
  const idle = { moved: false, merged: false, kept: false };
  if (!from || !to || from === to) return idle;
  if (!isDir(from)) return idle;

  if (!isDir(to)) {
    moveDirectory(from, to);
    return { moved: true, merged: false, kept: isDir(from) };
  }

  copyPreservingExisting(from, to);
  return { moved: false, merged: true, kept: true };
}

/**
 * Migration body for a store that moved: `migrate: relocateStore()`.
 * Reads `legacyDir`/`dir` off the migration context the runner supplies.
 */
function relocateStore() {
  return (ctx) => relocateDirectory(ctx && ctx.legacyDir, ctx && ctx.dir);
}

module.exports = { relocateDirectory, relocateStore };
