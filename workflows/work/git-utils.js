/**
 * git-utils.js — Git helper functions for worktree-aware operations.
 *
 * Extracted from work.workflow.js (GH-260) to enable unit testing
 * and reuse across modules.
 */

const fs = require('fs');
const path = require('path');

/**
 * Resolve the HEAD ref for a git repository or worktree.
 *
 * In a worktree, `.git` is a file containing `gitdir: <path>`.
 * This function reads HEAD from the resolved gitdir path.
 *
 * @param {string} [cwd=process.cwd()] - The working directory to resolve from
 * @returns {string} The trimmed contents of HEAD (e.g. "ref: refs/heads/main")
 * @throws {Error} If .git content is unexpected (not a gitdir pointer)
 */
function resolveGitHead(cwd) {
  const dotgitPath = path.join(cwd || process.cwd(), '.git');

  // Check if .git is a file (worktree) or directory (normal repo)
  const stat = fs.statSync(dotgitPath);
  if (stat.isDirectory()) {
    // Normal repo — read HEAD directly
    return fs.readFileSync(path.join(dotgitPath, 'HEAD'), 'utf-8').trim();
  }

  // Worktree — .git is a file containing "gitdir: <path>"
  const dotgit = fs.readFileSync(dotgitPath, 'utf-8').trim();
  if (dotgit.startsWith('gitdir: ')) {
    const rawGitdir = dotgit.slice('gitdir: '.length);
    const gitdir = path.resolve(path.dirname(dotgitPath), rawGitdir);
    return fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf-8').trim();
  }
  throw new Error(`unexpected .git content in ${dotgitPath}`);
}

module.exports = { resolveGitHead };
