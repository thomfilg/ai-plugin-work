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

/**
 * Read one git config key; '' on any failure.
 *
 * `gitDir` matters because it selects WHICH repository's config is read.
 * `git --git-dir=X commit` commits into X while the process still sits in the
 * shell's directory, so asking the shell's repository would answer about the
 * wrong one.
 */
function gitConfig(cwd, key, gitDir) {
  const args = ['-C', cwd];
  if (gitDir) args.push('--git-dir', gitDir);
  args.push('config', '--get', key);
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * The identity a commit authored against this target will carry.
 *
 * @param {string} cwd - directory the command runs in.
 * @param {string} [gitDir] - repository selected by `--git-dir` / `GIT_DIR`.
 * @returns {{name: string, email: string}}
 */
function resolveGitUser(cwd, gitDir) {
  const dir = cwd || process.cwd();
  return {
    name: gitConfig(dir, 'user.name', gitDir),
    email: gitConfig(dir, 'user.email', gitDir),
  };
}

module.exports = { resolveGitUser, gitConfig };
