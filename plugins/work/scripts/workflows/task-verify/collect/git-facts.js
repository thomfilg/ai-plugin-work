'use strict';

/**
 * task-verify/collect/git-facts.js — read-only git observations (GH-755).
 * Thin wrappers over `git -C <repo>`; every helper is best-effort and throws
 * only where the caller explicitly degrades to an UNVERIFIED flag.
 */

const { execFileSync } = require('child_process');

const GIT_TIMEOUT_MS = 30_000;

function git(repoDir, args, options = {}) {
  return execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

/** Files changed between two refs (name-only). */
function changedFiles(repoDir, baseRef, headRef) {
  const out = git(repoDir, ['diff', '--name-only', `${baseRef}..${headRef}`]);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** Merge base of two refs, or null. */
function mergeBase(repoDir, refA, refB) {
  try {
    return git(repoDir, ['merge-base', refA, refB]);
  } catch {
    return null;
  }
}

/** Does `ref:filePath` exist as a blob? */
function fileExistsAtRef(repoDir, ref, filePath) {
  try {
    git(repoDir, ['cat-file', '-e', `${ref}:${filePath}`]);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a ref to a SHA, or null. */
function resolveRef(repoDir, ref) {
  try {
    return git(repoDir, ['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch {
    return null;
  }
}

module.exports = { git, changedFiles, mergeBase, fileExistsAtRef, resolveRef };
