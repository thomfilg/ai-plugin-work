'use strict';
/**
 * session-scope.js — shared plumbing for the agent-free status-bar renderers:
 * read the Claude session_id off stdin and resolve TASKS_BASE from the env.
 * Both the follow-up and work bars scope their marker lookup with these, so the
 * bar only ever shows in the session that owns the run.
 */

const fs = require('fs');
const path = require('path');

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
 * TASKS_BASE for the current project — direnv exports it into the session env;
 * falls back to <WORKTREES_BASE>/tasks, then '' (render nothing).
 * @returns {string}
 */
function tasksBase() {
  if (process.env.TASKS_BASE) return process.env.TASKS_BASE;
  if (process.env.WORKTREES_BASE) return path.join(process.env.WORKTREES_BASE, 'tasks');
  return '';
}

module.exports = { readSessionId, tasksBase };
