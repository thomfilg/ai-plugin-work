/**
 * enforce-task-paths.js
 *
 * Task/ticket path resolution for the work-implement-enforce hook (GH-219):
 * TASKS_BASE + safe ticket id resolution, the active task number, the
 * conventional worktree directory, and the R6 allowed-paths object consumed
 * by isWriteAllowedPath.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { taskSegment } = require(path.join(__dirname, '..', '..', 'lib', 'allocate-output-folder'));
// Shared `<WORKTREES_BASE>/<repo>-<ticket>` lookup (same module the
// enforce-tdd-on-stop hook uses — keeps the two hooks from drifting).
const { conventionWorktreeDir } = require(path.join(__dirname, 'worktree-convention'));

/**
 * Resolve TASKS_BASE from environment or config.
 * Shared by checkTddPhase and the R6 path gate.
 */
function resolveTaskBase() {
  let taskBase;
  try {
    const cfg = require(path.join(__dirname, '..', '..', 'lib', 'config'));
    taskBase = process.env.TASKS_BASE || cfg.TASKS_BASE || null;
  } catch {
    taskBase = process.env.TASKS_BASE || null;
  }
  if (!taskBase) {
    taskBase =
      process.env.HOME || process.env.USERPROFILE
        ? path.join(process.env.HOME || process.env.USERPROFILE, 'worktrees', 'tasks')
        : null;
  }
  return taskBase;
}

/**
 * Sanitize a ticket ID via config.safeTicketId if available.
 * Shared by checkTddPhase and the R6 path gate.
 */
function resolveSafeTicketId(ticketId) {
  try {
    return require(path.join(__dirname, '..', '..', 'lib', 'config')).safeTicketId(ticketId);
  } catch {
    return ticketId;
  }
}

/**
 * Read the configured task number: WORK_TASK_NUM env var, falling back to
 * the work state's tasksMeta.currentTaskIndex. Returns the RAW value
 * (number | NaN | null) — buildAllowedPaths needs the null-vs-invalid
 * distinction to fail closed on a malformed WORK_TASK_NUM.
 */
function readConfiguredTaskNum(taskBase, safeTicketId) {
  let taskNum = process.env.WORK_TASK_NUM ? parseInt(process.env.WORK_TASK_NUM, 10) : null;
  if (!taskNum) {
    try {
      const statePath = path.join(taskBase, safeTicketId, '.work-state.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state?.tasksMeta?.currentTaskIndex != null) {
        taskNum = state.tasksMeta.currentTaskIndex + 1; // 0-indexed → 1-indexed
      }
    } catch {
      /* no state file */
    }
  }
  return taskNum;
}

/**
 * Resolve the active task number as a validated positive integer, or null.
 */
function resolveActiveTaskNum(taskBase, safeTicketId) {
  const taskNum = readConfiguredTaskNum(taskBase, safeTicketId);
  return Number.isInteger(taskNum) && taskNum > 0 ? taskNum : null;
}

/**
 * Detect the worktree directory for a ticket.
 *
 * Worktrees follow the convention `<WORKTREES_BASE>/<repo>-<TICKET_ID>` (per
 * inspect.js:44). Detection priority:
 *   1. process.env.WORK_WORKTREE_DIR — explicit override
 *   2. WORKTREES_BASE/<MAIN_WORKTREE_FOLDER>-<safeTicketId> — convention
 *   3. Walk up from process.cwd() looking for a dir whose name ends with
 *      `-<safeTicketId>` and whose parent is WORKTREES_BASE
 *
 * Returns null if no worktree can be confidently identified.
 *
 * @param {string} safeTicketId
 * @returns {string|null}
 */
function detectWorktreeDir(safeTicketId) {
  if (process.env.WORK_WORKTREE_DIR) return path.resolve(process.env.WORK_WORKTREE_DIR);

  // Shared `<WORKTREES_BASE>/<repo>-<ticket>` convention lookup (uses
  // config.REPO_NAME as fallback — same module enforce-tdd-on-stop uses).
  const conventional = conventionWorktreeDir(safeTicketId);
  if (conventional) return conventional;

  // Walk up from cwd looking for `<something>-<safeTicketId>` whose parent
  // is WORKTREES_BASE (or any parent if WORKTREES_BASE unset).
  try {
    const wbase = process.env.WORKTREES_BASE;
    const wbaseResolved = wbase ? path.resolve(wbase) : null;
    let dir = process.cwd();
    const root = path.parse(dir).root;
    while (dir !== root) {
      const base = path.basename(dir);
      if (base.endsWith(`-${safeTicketId}`)) {
        const parent = path.dirname(dir);
        if (!wbaseResolved || path.resolve(parent) === wbaseResolved) {
          return path.resolve(dir);
        }
      }
      dir = path.dirname(dir);
    }
  } catch {
    /* fail-closed */
  }
  return null;
}

/**
 * Build the allowed-paths object for isWriteAllowedPath (R6).
 * Only active when WORK_TASK_NUM is set (task-aware mode).
 * Legacy mode (no WORK_TASK_NUM) skips the path gate entirely.
 *
 * @param {string} taskBase - Resolved TASKS_BASE
 * @param {string} safeTicketId - Sanitized ticket ID
 * @returns {{ prDir: string|null, taskDir: string|null, ticketRoot: string, worktreeDir: string|null }|null}
 */
function buildAllowedPaths(taskBase, safeTicketId) {
  const taskNum = readConfiguredTaskNum(taskBase, safeTicketId);

  // No task num = legacy mode; invalid taskNum = fail-closed
  if (taskNum == null) return null;
  if (!Number.isInteger(taskNum) || taskNum < 1)
    return { prDir: null, taskDir: null, ticketRoot: null, worktreeDir: null };

  const ticketRoot = path.join(taskBase, safeTicketId);
  let taskDir = null;
  try {
    taskDir = path.join(ticketRoot, taskSegment(taskNum));
  } catch {
    taskDir = path.join(ticketRoot, 'task' + taskNum);
  }

  // PR slot for worktree dir
  const prSlot = process.env.WORK_PR_SLOT ? parseInt(process.env.WORK_PR_SLOT, 10) : null;
  const prDir =
    prSlot && Number.isInteger(prSlot) && prSlot > 0 ? path.join(ticketRoot, 'PR' + prSlot) : null;

  // Worktree path — when running inside a `<repo>-<TICKET>` worktree, the
  // entire worktree is the legitimate write zone for this ticket. Most real
  // tasks edit repo source files, not files under tasks/<TICKET>/task{N}/.
  // (Workaround for path-gate-blocks-repo-writes issue from echo-4520-issue-2.)
  const worktreeDir = detectWorktreeDir(safeTicketId);

  return { prDir, taskDir, ticketRoot, worktreeDir };
}

module.exports = {
  resolveTaskBase,
  resolveSafeTicketId,
  readConfiguredTaskNum,
  resolveActiveTaskNum,
  detectWorktreeDir,
  buildAllowedPaths,
};
