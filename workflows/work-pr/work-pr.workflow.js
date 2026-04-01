#!/usr/bin/env node

/**
 * work-pr.workflow.js
 *
 * Workflow definition for the /work-pr command.
 * Orchestrates PR description generation and visual documentation with
 * SHA-based caching and a screenshot gate for UI changes.
 *
 * Steps:
 *   1. Pre-flight memory & zombie check
 *   2. Parse args, set variables
 *   3. Run pr-generator (SHA-gated with compound key: HEAD|screenshotHash)
 *   4. Screenshot gate for TSX/JSX changes
 *   5. Run pr-post-generator (content SHA-gated)
 *   6. Print summary
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── Constants ──────────────────────────────────────────────────────────────

const getConfig = require(path.join(__dirname, '..', 'lib', 'get-config'));
const WORKTREES_BASE = getConfig.require('WORKTREES_BASE');
const TASKS_BASE = getConfig('TASKS_BASE') || path.join(WORKTREES_BASE, 'tasks');

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTasksDir(ticketId) {
  return path.join(TASKS_BASE, ticketId);
}

function getWorktreeDir(ticketId) {
  const repo = process.env.REPO_NAME || 'my-project';
  return path.join(WORKTREES_BASE, `${repo}-${ticketId}`);
}

function safeExec(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', ...options }).trim();
  } catch {
    return '';
  }
}

// ─── Workflow Definition ────────────────────────────────────────────────────

module.exports = {
  name: 'work-pr',
  command: '/work-pr',
  stateDir: path.join(TASKS_BASE),

  steps: [
    { id: '1_preflight',       name: 'Memory & zombie check',  command: 'bash pre-flight script' },
    { id: '2_setup',           name: 'Parse args, set variables', command: 'internal' },
    { id: '3_pr_gen',          name: 'Run pr-generator',       command: 'Task(pr-generator)' },
    { id: '4_screenshot_gate', name: 'Screenshot gate',        command: 'internal + AskUserQuestion' },
    { id: '5_post_pr_gen',     name: 'Run pr-post-generator',  command: 'Task(pr-post-generator)' },
    { id: '6_summary',         name: 'Print summary',          command: 'internal' },
  ],

  transitions: [
    { source: '1_preflight',       targets: ['2_setup'] },
    { source: '2_setup',           targets: ['3_pr_gen', '4_screenshot_gate', '5_post_pr_gen', '6_summary'] },
    { source: '3_pr_gen',          targets: ['4_screenshot_gate', '5_post_pr_gen', '6_summary'] },
    { source: '4_screenshot_gate', targets: ['5_post_pr_gen', '3_pr_gen', '6_summary'] },
    { source: '5_post_pr_gen',     targets: ['6_summary'] },
    { source: '6_summary',         targets: [] },
  ],

  /**
   * Parse CLI arguments into workflow params.
   * Accepts: "PROJ-856", "856", "856 --force"
   * @param {string} args - Raw argument string
   * @returns {{ instanceId: string, ticketId: string, force: boolean }}
   */
  params(args) {
    const parts = args.trim().split(/\s+/);
    if (!parts[0]) {
      throw new Error('Usage: /work-pr <ticket-id> [--force]');
    }

    const force = parts.includes('--force');
    let ticketId = parts[0];

    // Prefix with project key if just a number
    if (/^\d+$/.test(ticketId)) {
      ticketId = `${process.env.TICKET_PROJECT_KEY || process.env.JIRA_PROJECT_KEY || 'PROJ'}-${ticketId}`;
    }
    // Ensure uppercase
    ticketId = ticketId.toUpperCase();

    return { instanceId: ticketId, ticketId, force };
  },

  /**
   * Inspect real filesystem state for an instance.
   * Uses the ticket-specific worktree directory for all git commands.
   * @param {string} instanceId - The ticket ID
   * @returns {object} Inspection data
   */
  inspect(instanceId) {
    const tasksDir = getTasksDir(instanceId);
    const worktreeDir = getWorktreeDir(instanceId);
    const data = {
      tasksDir,
      tasksDirExists: fs.existsSync(tasksDir),
      worktreeDir,
      worktreeExists: fs.existsSync(worktreeDir),
    };

    // Current HEAD SHA (from ticket worktree)
    data.headSha = safeExec('git rev-parse HEAD', { cwd: worktreeDir });

    // .pr-update-sha (stores compound key: HEAD_SHA|SCREENSHOT_HASH)
    const prShaFile = path.join(tasksDir, '.pr-update-sha');
    data.prShaFile = prShaFile;
    data.lastPrSha = '';
    if (fs.existsSync(prShaFile)) {
      try { data.lastPrSha = fs.readFileSync(prShaFile, 'utf8').trim(); } catch { /* */ }
    }

    // TSX/JSX changes vs main (from ticket worktree)
    let baseBranch = 'origin/main';
    try { baseBranch = require(path.join(__dirname, '..', 'lib', 'config')).getBaseBranch({ cwd: worktreeDir }); } catch { /* */ }
    data.tsxChanged = safeExec(`git diff --name-only ${baseBranch}...HEAD -- '*.tsx' '*.jsx'`, { cwd: worktreeDir });
    data.hasTsxChanges = data.tsxChanged.length > 0;

    // Screenshot count
    const screenshotDir = path.join(tasksDir, 'screenshots');
    data.screenshotDir = screenshotDir;
    data.screenshotCount = 0;
    if (fs.existsSync(screenshotDir)) {
      try {
        const files = safeExec(`find "${screenshotDir}" -type f \\( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.gif' -o -name '*.webp' \\) 2>/dev/null`);
        data.screenshotCount = files ? files.split('\n').filter(Boolean).length : 0;
      } catch { /* */ }
    }
    data.screenshotsExist = data.screenshotCount > 0;

    // Screenshot hash for compound gating key
    let screenshotHash = 'none';
    if (data.screenshotsExist) {
      screenshotHash = safeExec(
        `find "${screenshotDir}" -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1`
      ) || 'none';
    }
    data.screenshotHash = screenshotHash;

    // Compound pr-gen gating key: HEAD_SHA|SCREENSHOT_HASH
    data.prKey = `${data.headSha}|${data.screenshotHash}`;
    data.prUpToDate = !!(data.prKey && data.prKey === data.lastPrSha);

    // Content SHA for post-pr (all *.check.md + screenshots)
    data.contentSha = safeExec(
      `(
        find "${tasksDir}" -maxdepth 1 -name '*.check.md' -print0 2>/dev/null | sort -z | xargs -0 sha256sum 2>/dev/null
        find "${tasksDir}/screenshots" -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum 2>/dev/null
      ) | sha256sum | cut -d' ' -f1`
    );

    // .post-pr-update-sha
    const postPrShaFile = path.join(tasksDir, '.post-pr-update-sha');
    data.postPrShaFile = postPrShaFile;
    data.lastPostPrSha = '';
    if (fs.existsSync(postPrShaFile)) {
      try { data.lastPostPrSha = fs.readFileSync(postPrShaFile, 'utf8').trim(); } catch { /* */ }
    }
    data.postPrUpToDate = !!(data.contentSha && data.contentSha === data.lastPostPrSha);

    // SKIP 5_post_pr_gen if no content to post
    data.hasContent = !!(data.contentSha && data.contentSha !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

    return data;
  },

  /**
   * Determine step action (RUN/SKIP) for each step.
   * @param {string} stepId
   * @param {string} instanceId
   * @param {object|null} state - Existing workflow state
   * @param {object} inspectData - Data from inspect()
   * @returns {{ action: string, reason: string, command?: string }}
   */
  detectStepState(stepId, instanceId, state, inspectData) {
    const d = inspectData || {};
    // Check if force mode is set via params (passed through state)
    const force = state?.force || false;

    switch (stepId) {
      case '1_preflight':
        return { action: 'RUN', reason: 'Check memory & zombie processes' };

      case '2_setup':
        return { action: 'RUN', reason: 'Parse args and set variables' };

      case '3_pr_gen':
        if (!force && d.prUpToDate) {
          return {
            action: 'SKIP',
            reason: `Compound key matches (${d.headSha?.slice(0, 8)}|${d.screenshotHash?.slice(0, 8)})`,
          };
        }
        return {
          action: 'RUN',
          reason: force ? 'Force mode — regenerating PR description' :
            d.lastPrSha ? `Key changed: ${d.lastPrSha?.slice(0, 16)}… → ${d.prKey?.slice(0, 16)}…` :
            'No previous PR update recorded',
          command: 'Task(pr-generator)',
        };

      case '4_screenshot_gate':
        if (!d.hasTsxChanges) {
          return { action: 'SKIP', reason: 'No TSX/JSX files changed' };
        }
        if (d.screenshotsExist) {
          return {
            action: 'SKIP',
            reason: `${d.screenshotCount} screenshot(s) found`,
          };
        }
        return {
          action: 'RUN',
          reason: 'TSX/JSX changed but no screenshots — gate required',
          command: 'AskUserQuestion',
        };

      case '5_post_pr_gen':
        if (!d.hasContent) {
          return {
            action: 'SKIP',
            reason: 'No content to post (no check reports or screenshots)',
          };
        }
        if (!force && d.postPrUpToDate) {
          return {
            action: 'SKIP',
            reason: 'Content SHA matches .post-pr-update-sha',
          };
        }
        return {
          action: 'RUN',
          reason: force ? 'Force mode — regenerating post-PR content' :
            d.lastPostPrSha ? 'Content changed since last run' :
            'No previous post-PR update recorded',
          command: 'Task(pr-post-generator)',
        };

      case '6_summary':
        return { action: 'RUN', reason: 'Print completion summary' };

      default:
        return { action: 'RUN', reason: 'Unknown step' };
    }
  },

  /** Extra fields to include in initial state */
  extraStateFields: {
    force: false,
    prUpdated: false,
    postPrUpdated: false,
  },
};
