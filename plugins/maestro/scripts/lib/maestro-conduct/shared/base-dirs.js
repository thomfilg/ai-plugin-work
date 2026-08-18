'use strict';

/**
 * base-dirs.js — the single source of truth for maestro's base directories.
 *
 * Three modules (`workstate.js`, `skill-registry.js`,
 * `shared/skill-registry-rows.js`) each carried their own copy of:
 *
 *   const worktrees = process.env.WORKTREES_BASE || path.join(os.homedir(), 'worktrees');
 *   return process.env.TASKS_BASE || path.join(worktrees, 'tasks');
 *
 * Both `||` arms are guesses. `~/worktrees` is not the operator's worktrees
 * root, and `<worktrees>/tasks` is not the operator's tasks root — they merely
 * look like them, so every reader accepted the invented path and reported "no
 * state" for tickets whose state exists somewhere else. This is the same class
 * `plugins/work` burned down in #788/#791/#792, arriving here by copy-paste.
 *
 * maestro is a READER of another plugin's state: it never creates these
 * directories, it only looks inside them. So an unconfigured base is not an
 * error to raise, it is simply "no state to read" — every accessor returns null
 * and the callers already treat null as absent state.
 */

/** The configured worktrees root, or null. Never derived from $HOME. */
function worktreesBase() {
  return process.env.WORKTREES_BASE || null;
}

/** The configured tasks root, or null. Never derived from WORKTREES_BASE. */
function tasksBase() {
  return process.env.TASKS_BASE || null;
}

/**
 * `<TASKS_BASE>/<ticket>/<basename>`, or null when no tasks root is configured.
 * Centralised so no caller joins a ticket onto a base it resolved itself.
 */
function ticketStateFile(ticket, basename) {
  const base = tasksBase();
  if (!base || !ticket) return null;
  return require('path').join(base, ticket, basename);
}

/**
 * `<WORKTREES_BASE>/<repoName>-<ticket>`, or null when no worktrees root is
 * configured. The naming convention mirrors plugins/work `config.worktreeDir`.
 */
function worktreeDir(repoName, ticket) {
  const base = worktreesBase();
  if (!base || !repoName || !ticket) return null;
  return require('path').join(base, `${repoName}-${ticket}`);
}

module.exports = { worktreesBase, tasksBase, ticketStateFile, worktreeDir };
