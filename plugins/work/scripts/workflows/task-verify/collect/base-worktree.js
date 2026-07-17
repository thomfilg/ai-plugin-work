'use strict';

/**
 * task-verify/collect/base-worktree.js — base-worktree manager for the
 * retroactive-red check (GH-755; plan §5.4).
 *
 * Once per ticket: `git worktree add --detach <dir> <base>` + node_modules
 * symlinked from the main checkout (the known-good fresh-worktree pattern).
 * Per task: overlay the task's derived test files from head onto the base
 * tree and run only those files. Reaped at cleanup.
 *
 * Every failure here is a MECHANISM failure: callers map throws to
 * `UNVERIFIED + base-setup-failed`, never to a contradiction.
 */

const fs = require('fs');
const path = require('path');

const { git } = require('./git-facts');

/**
 * Create (or reuse) a detached worktree of `repoDir` at `ref` in `dir`.
 * On reuse the tree is re-pointed at `ref` and scrubbed of prior overlays
 * (reset --hard + clean, sparing the node_modules symlink), so each task's
 * base run starts from a pristine base tree.
 * @returns {{ dir: string, created: boolean }}
 */
function ensureBaseWorktree({ repoDir, ref, dir }) {
  if (fs.existsSync(path.join(dir, '.git'))) {
    git(dir, ['reset', '--hard', ref]);
    git(dir, ['clean', '-fdq', '-e', 'node_modules']);
    return { dir, created: false };
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(repoDir, ['worktree', 'add', '--detach', dir, ref]);

  const sourceModules = path.join(repoDir, 'node_modules');
  const targetModules = path.join(dir, 'node_modules');
  if (fs.existsSync(sourceModules) && !fs.existsSync(targetModules)) {
    fs.symlinkSync(sourceModules, targetModules, 'dir');
  }
  return { dir, created: true };
}

/** Overlay `files` from `headRef` onto the base worktree. */
function overlayFiles({ baseDir, headRef, files }) {
  if (!files || files.length === 0) return;
  git(baseDir, ['checkout', headRef, '--', ...files]);
}

/** Remove the base worktree (best-effort; used by cleanup). */
function reapBaseWorktree({ repoDir, dir }) {
  try {
    git(repoDir, ['worktree', 'remove', '--force', dir]);
    return true;
  } catch {
    return false;
  }
}

module.exports = { ensureBaseWorktree, overlayFiles, reapBaseWorktree };
