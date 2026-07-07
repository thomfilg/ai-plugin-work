'use strict';

/**
 * stop-hook-utils.js — shared plumbing for the review Stop hooks
 * (work-code-review-status.js and work-suggestion-replies.js).
 *
 * Both hooks share the same fail-open error handlers, config loading, codex
 * self-filtering, task-id resolution, recency check, and directory fan-out.
 * Centralising them keeps the two hooks byte-identical in behavior while
 * removing the duplicated blocks the quality gate flagged.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));
const { getRuntime } = require(path.join(__dirname, '..', '..', 'lib', 'runtime'));

// hooks.json Stop matcher, re-applied in-code: codex ignores Stop matchers
// entirely and fires this hook on every stop, so the script gates itself on
// last_assistant_message there. Claude keeps matcher-side gating (its Stop
// payload has no last_assistant_message to re-check).
const STOP_MATCHER_RE =
  /.*(\/check|code.?review|quality.?check|APPROVED|PASS|tests?.?md|code-review.?md|qa.?md).*/;

/**
 * Install the fail-open-unless-blocking handlers shared by the review Stop
 * hooks. Returns a mutable state object: set `state.didBlock = true` right
 * before a blocking `process.exit(2)` so a late crash preserves the block.
 */
function createBlockState(filename) {
  const state = { didBlock: false };
  const bail = (err) => {
    logHookError(filename, err);
    process.exit(state.didBlock ? 2 : 0);
  };
  process.on('uncaughtException', bail);
  process.on('unhandledRejection', bail);
  return state;
}

/**
 * Load the workflow config module, tolerating ONLY its own absence
 * (MODULE_NOT_FOUND for the config path itself → null; anything else throws).
 * Callers exit 0 on null — the hooks are inert without a configured project.
 */
function loadStopHookConfig() {
  try {
    return require('../../lib/config');
  } catch (err) {
    if (
      err &&
      err.code === 'MODULE_NOT_FOUND' &&
      /['"]\.\.\/\.\.\/lib\/config['"]/.test(err.message)
    ) {
      return null;
    }
    throw err;
  }
}

/** Read the whole hook payload from stdin. */
async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

/**
 * Codex fires Stop hooks on every stop (matchers are ignored there), so the
 * hooks re-apply the hooks.json matcher against last_assistant_message
 * in-code. Claude payloads carry no last_assistant_message → never skipped.
 */
function shouldSkipCodexStop(hookData) {
  const rt = getRuntime(hookData);
  const evt = rt.normalizeHookPayload(hookData, { event: 'Stop' });
  return rt.name === 'codex' && !STOP_MATCHER_RE.test(evt.lastAssistantText || '');
}

// Get current task ID from cwd or git branch
function getCurrentTaskId(config, cwd) {
  // Try to get from worktree folder name (e.g., ${config.REPO_NAME}-${jira_task_id})
  const worktreeMatch = cwd.match(new RegExp(`${config.TICKET_PROJECT_KEY}-(\\d+)`, 'i'));
  if (worktreeMatch) {
    return `${config.TICKET_PROJECT_KEY}-${worktreeMatch[1]}`;
  }

  // Try to get from git branch name
  try {
    const branch = execSync('git branch --show-current', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const branchMatch = branch.match(new RegExp(`${config.TICKET_PROJECT_KEY}-(\\d+)`, 'i'));
    if (branchMatch) {
      return `${config.TICKET_PROJECT_KEY}-${branchMatch[1]}`;
    }
  } catch {
    // Ignore git errors
  }

  return null;
}

// Check if file was modified in last 10 minutes
function isRecentlyModified(filePath) {
  try {
    const stats = fs.statSync(filePath);
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    return stats.mtimeMs > tenMinutesAgo;
  } catch {
    return false;
  }
}

/** Directories that may hold the current task's reports: cwd + main worktree. */
function reviewDirsToCheck(config, cwd) {
  const mainWorktree = config.repoDir();
  const dirsToCheck = [cwd];
  if (cwd !== mainWorktree) {
    dirsToCheck.push(mainWorktree);
  }
  return dirsToCheck;
}

module.exports = {
  createBlockState,
  getCurrentTaskId,
  isRecentlyModified,
  loadStopHookConfig,
  readStdin,
  reviewDirsToCheck,
  shouldSkipCodexStop,
};
