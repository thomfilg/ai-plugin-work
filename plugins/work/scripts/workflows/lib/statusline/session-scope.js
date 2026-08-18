'use strict';
/**
 * session-scope.js — shared plumbing for the agent-free status-bar renderers:
 * read the Claude session_id off stdin and resolve TASKS_BASE from the env.
 * Both the follow-up and work bars scope their marker lookup with these, so the
 * bar only ever shows in the session that owns the run.
 */

const fs = require('fs');

/**
 * The Claude session id Claude passes on stdin as `{ session_id }`, or '' when
 * absent (plain CLI / no stdin).
 * @returns {string}
 */
function readSessionId() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}').session_id || '';
  } catch {
    return '';
  }
}

/**
 * TASKS_BASE for the current project — direnv exports it into the session env,
 * otherwise '' (render nothing).
 *
 * The `<WORKTREES_BASE>/tasks` fallback is gone (#788's rule): the two are
 * separate locations, so the derivation pointed the statusline at a directory
 * nothing writes to. Rendering nothing is honest; rendering another
 * directory's state as this project's is not.
 * @returns {string}
 */
function tasksBase() {
  return process.env.TASKS_BASE || '';
}

module.exports = { readSessionId, tasksBase };
