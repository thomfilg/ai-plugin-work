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
function gitConfig(cwd, key, gitDir, configSources) {
  const args = ['-C', cwd];
  if (gitDir) args.push('--git-dir', gitDir);
  args.push('config', '--get', key);
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      // GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM point git at different config
      // FILES. Reading without them answers about a config git will not use.
      env: { ...process.env, ...(configSources || {}) },
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
function resolveGitUser(cwd, gitDir, configSources) {
  const dir = cwd || process.cwd();
  return {
    name: gitConfig(dir, 'user.name', gitDir, configSources),
    email: gitConfig(dir, 'user.email', gitDir, configSources),
  };
}

/**
 * What an existing commit would hand to a command that reuses it.
 *
 * `git cherry-pick <ref>` and `git commit -C <ref>` copy BOTH the author and
 * the message onto the new commit. Resolving only the author leaves the other
 * half — an attribution trailer already sitting in that commit rides along
 * untouched. Returns empty fields when the ref cannot be resolved, which is
 * the case where git itself would fail.
 *
 * `%B` is the raw body and may span many lines, so it is everything after the
 * first two.
 *
 * @returns {{name: string, email: string, message: string}}
 */
function resolveCommitInfo(cwd, gitDir, ref) {
  const args = ['-C', cwd || process.cwd()];
  if (gitDir) args.push('--git-dir', gitDir);
  args.push('log', '-1', '--format=%an%n%ae%n%B', ref, '--');
  try {
    const lines = execFileSync('git', args, {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n');
    return {
      name: (lines[0] || '').trim(),
      email: (lines[1] || '').trim(),
      message: lines.slice(2).join('\n'),
    };
  } catch {
    return { name: '', email: '', message: '' };
  }
}

/**
 * The GitHub account `gh` would post as.
 *
 * Best effort by design: `gh auth status` is the only place the active login
 * is written down, its wording has moved between versions, and it prints to
 * stderr on some. An unresolvable account returns '' — the guard decides what
 * that means, and the answer differs depending on whether an expected identity
 * is configured.
 *
 * @param {string} cwd
 * @returns {string} the login, or '' when it cannot be read.
 */
function resolveGhAccount(cwd) {
  try {
    const output = execFileSync('gh', ['auth', 'status'], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const match = /account\s+(\S+)/i.exec(output);
    return match ? match[1] : '';
  } catch (err) {
    // gh writes the status to stderr on older versions, and exits non-zero
    // when any host is logged out — the login we want may still be in there.
    const text = (err && (err.stdout || '') + (err.stderr || '')) || '';
    const match = /account\s+(\S+)/i.exec(text);
    return match ? match[1] : '';
  }
}

module.exports = { resolveGitUser, resolveCommitInfo, resolveGhAccount, gitConfig };
