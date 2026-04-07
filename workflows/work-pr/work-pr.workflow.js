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
const { normalizeTicketId } = require(path.join(__dirname, '..', 'lib', 'ticket-provider'));
const safeTicketId = require(path.join(__dirname, '..', 'lib', 'config')).safeTicketId;

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTasksDir(ticketId) {
  return path.join(TASKS_BASE, safeTicketId(ticketId));
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


/**
 * Compute a deterministic hash of screenshot files in a directory.
 * Uses Node.js crypto to avoid shell injection risks entirely.
 * @param {string} screenshotDir - Absolute path to screenshots directory
 * @returns {string} SHA256 hash or 'none' if no screenshots
 */
function computeScreenshotHash(screenshotDir) {
  if (!fs.existsSync(screenshotDir)) return 'none';
  const crypto = require('crypto');
  const extensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
  // Manual recursive traversal — avoids reliance on { recursive: true } (Node 18.17+)
  function walkDir(dir, base) {
    let results = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (err) {
      if (err.code !== 'ENOENT') process.stderr.write(`[work-pr] computeScreenshotHash: cannot read ${dir}: ${err.message}\n`);
      return results;
    }
    for (const entry of entries) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results = results.concat(walkDir(path.join(dir, entry.name), rel));
      } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        results.push(rel);
      }
    }
    return results;
  }
  const files = walkDir(screenshotDir, '').sort();
  if (files.length === 0) return 'none';
  const hash = crypto.createHash('sha256');
  let filesHashed = 0;
  for (const file of files) {
    const fullPath = path.join(screenshotDir, file);
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile() || stat.size > 50 * 1024 * 1024) continue;
      // Stream file in 64KB chunks to bound memory usage
      const fd = fs.openSync(fullPath, 'r');
      try {
        const fileHash = crypto.createHash('sha256');
        const buf = Buffer.alloc(65536);
        let bytesRead;
        while ((bytesRead = fs.readSync(fd, buf, 0, buf.length)) > 0) {
          fileHash.update(buf.subarray(0, bytesRead));
        }
        hash.update(`${fileHash.digest('hex')}  ${file}\n`);
        filesHashed++;
      } finally {
        fs.closeSync(fd);
      }
    } catch { /* skip unreadable files */ }
  }
  if (filesHashed === 0) return 'none';
  return hash.digest('hex');
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
    // Uppercase only the ticket base, preserve suffix case (GH-146)
    ticketId = normalizeTicketId(ticketId);

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

    // Rebase guard: count commits behind base branch (opt-in via REBASE_GUARD_ENABLED=1)
    data.baseBranch = baseBranch;
    data.commitsBehindMain = 0;
    if (data.worktreeExists && process.env.REBASE_GUARD_ENABLED === '1') {
      const parts = baseBranch.split('/');
      const remote = parts.length > 1 ? parts[0] : 'origin';
      const branch = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
      // Validate remote/branch to prevent command injection
      const validRef = /^[a-zA-Z0-9_\-./]+$/.test(remote) && /^[a-zA-Z0-9_\-./]+$/.test(branch);
      if (!validRef) {
        process.stderr.write(`[work-pr] rebase guard: invalid baseBranch "${baseBranch}" — skipping\n`);
      } else {
        const guardThreshold = parseInt(process.env.REBASE_GUARD_THRESHOLD || '0', 10);
        const fetchDepth = Math.max((Number.isFinite(guardThreshold) ? guardThreshold : 0) + 2, 2);
        safeExec(`git fetch ${remote} ${branch} --quiet --depth=${fetchDepth} --no-tags`, { cwd: worktreeDir, timeout: 5000 });
        const fetchedRef = `${remote}/${branch}`;
        const behind = safeExec(`git rev-list --count --max-count=${fetchDepth} HEAD..${fetchedRef}`, { cwd: worktreeDir });
        data.commitsBehindMain = parseInt(behind || '0', 10); // capped by fetchDepth, flagged via commitsBehindMainCapped
        data.commitsBehindMainCapped = data.commitsBehindMain >= fetchDepth;
      }
    }

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
    const screenshotHash = computeScreenshotHash(screenshotDir);
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

      case '3_pr_gen': {
        // Rebase guard: block if worktree is behind main
        const parsed = parseInt(process.env.REBASE_GUARD_THRESHOLD || '0', 10);
        const threshold = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
        if (d.commitsBehindMain > threshold) {
          return {
            action: 'BLOCKED',
            reason: `Worktree is ${d.commitsBehindMainCapped ? '>= ' : ''}${d.commitsBehindMain} commit(s) behind ${d.baseBranch || 'origin/main'}. Rebase before creating PR.`,
          };
        }
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
      }

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

  /**
   * Post-transition hook: write .pr-update-sha programmatically after 3_pr_gen completes.
   * @param {string} from - Source step
   * @param {string} to - Target step
   * @param {string} instanceId - Ticket ID
   */
  onTransition(from, to, instanceId) {
    // Write .pr-update-sha only on forward transitions from 3_pr_gen (PR generation completed)
    const forwardTargets = ['4_screenshot_gate', '5_post_pr_gen', '6_summary'];
    if (from === '3_pr_gen' && forwardTargets.includes(to)) {
      const tasksDir = getTasksDir(instanceId);
      const worktreeDir = getWorktreeDir(instanceId);
      const headSha = safeExec('git rev-parse HEAD', { cwd: worktreeDir });
      if (!headSha) {
        process.stderr.write(`[work-pr] onTransition: cannot determine HEAD for ${instanceId} (worktree: ${worktreeDir}) — skipping .pr-update-sha write\n`);
        return;
      }
      const screenshotDir = path.join(tasksDir, 'screenshots');
      const screenshotHash = computeScreenshotHash(screenshotDir);
      const compoundKey = `${headSha}|${screenshotHash}`;
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(path.join(tasksDir, '.pr-update-sha'), compoundKey + '\n');
    } // headSha absence is logged to stderr for diagnosis
  },

  /** Extra fields to include in initial state */
  extraStateFields: {
    force: false,
    prUpdated: false,
    postPrUpdated: false,
  },
};

// Test-only export
module.exports._computeScreenshotHash = computeScreenshotHash;
