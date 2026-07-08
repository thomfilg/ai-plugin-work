'use strict';

/**
 * git-identity.js — resolve the git identity that will author commits in a
 * worktree, and flag identities that look like an AI tool (GH-539).
 *
 * The commit-msg validator uses this to BLOCK commits authored as "Claude",
 * "Codex", "Gemini", etc. — the agent must commit under a real human user.
 *
 * Identity resolution (per the operator's rule):
 *   - If a worktree-level `.envrc` exists (the per-worktree credential setup),
 *     use the worktree's effective git config (`git -C <wt> config user.*`).
 *   - Otherwise fall back to the GLOBAL git user (`git config --global user.*`).
 */

const { execFileSync } = require('child_process');
const { findNearestEnvrc } = require('./envrc-resolver');
const { AI_TOOL_NAMES } = require('../work/hooks/commit-msg-rules');

// A git name/email that contains a bare AI-tool token is rejected.
const AI_IDENTITY_RE = new RegExp('\\b(?:' + AI_TOOL_NAMES.join('|') + ')\\b', 'i');

/** Read a git config key (optionally forcing --global). Returns '' on any error. */
function gitConfig(worktree, key, useGlobal) {
  try {
    const args = ['-C', worktree, 'config'];
    if (useGlobal) args.push('--global');
    args.push('--get', key);
    return execFileSync('git', args, { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    return '';
  }
}

/**
 * Resolve the identity commits will use in `worktree`.
 *
 * We read the EFFECTIVE git config (`user.name`/`user.email` with no `--global`
 * flag) — this is what git actually commits as: a worktree/local value when set,
 * otherwise the global user. That is exactly the operator's rule ("use the
 * worktree credentials when the worktree .envrc set them up, else the global
 * user") AND it robustly catches a rogue LOCAL AI identity that a bare --global
 * read would miss. When no local value exists we fall back to the explicit
 * global read so the reported identity is never empty. `source` is derived from
 * the presence of a worktree `.envrc` purely for the diagnostic message.
 * @param {string} worktree
 * @returns {{source: 'worktree'|'global', name: string, email: string}}
 */
function resolveGitUser(worktree) {
  const source = findNearestEnvrc(worktree) ? 'worktree' : 'global';
  return {
    source,
    name: gitConfig(worktree, 'user.name', false) || gitConfig(worktree, 'user.name', true),
    email: gitConfig(worktree, 'user.email', false) || gitConfig(worktree, 'user.email', true),
  };
}

/**
 * Whether a resolved identity looks like an AI tool (must be blocked).
 * @param {{name: string, email: string}} user
 * @returns {boolean}
 */
function isAiIdentity(user) {
  return AI_IDENTITY_RE.test(`${user && user.name} ${user && user.email}`);
}

module.exports = { resolveGitUser, isAiIdentity, AI_IDENTITY_RE };
