'use strict';

/**
 * git-identity.js — read the identity git would actually stamp on a commit
 * made in `cwd`.
 *
 * The EFFECTIVE config is what matters, not the global one: a repo-local or
 * worktree-local `user.name` overrides the global user, and a rogue local
 * value is exactly the case a global-only read would miss. `git config --get`
 * with no scope flag resolves that precedence for us.
 *
 * Every failure path degrades to empty strings. A missing git, a directory
 * that is not a repository, or a config read that times out must never turn
 * into a blocked command — the guard treats an unknown identity as clean and
 * relies on its other rules.
 */

const { execFileSync } = require('node:child_process');

const GIT_TIMEOUT_MS = 5000;

/** Read one git config key in `cwd`; '' on any failure. */
function gitConfig(cwd, key) {
  try {
    return execFileSync('git', ['-C', cwd, 'config', '--get', key], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * The identity a commit authored in `cwd` will carry.
 *
 * @param {string} cwd - directory the command runs in.
 * @returns {{name: string, email: string}}
 */
function resolveGitUser(cwd) {
  const dir = cwd || process.cwd();
  return { name: gitConfig(dir, 'user.name'), email: gitConfig(dir, 'user.email') };
}

module.exports = { resolveGitUser, gitConfig };
