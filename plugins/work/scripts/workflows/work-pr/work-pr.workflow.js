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

// ─── Constants ──────────────────────────────────────────────────────────────

const config = require(path.join(__dirname, '..', 'lib', 'config'));
const getConfig = require(path.join(__dirname, '..', 'lib', 'get-config'));
// Load-time assertion only: this workflow cannot resolve a ticket worktree
// without it. The value itself is read where it is needed.
getConfig.require('WORKTREES_BASE');
// TASKS_BASE is configured, never derived — see lib/config.js. This file used to
// carry its own `|| path.join(WORKTREES_BASE, 'tasks')` copy of the guess #788
// removed, which survived even after config.js stopped making it.
//
// Resolved on READ, not at load. This workflow's `stateDir` is the tasks base,
// so a load-time `getConfig.require` (the shape WORKTREES_BASE uses above)
// would couple "can this workflow be described" to "is a tasks root
// configured" — and they are separate questions: name, command, steps and
// transitions are all answerable without one. Reading `stateDir` or building a
// tasks dir is where the requirement actually bites, so that is where it
// refuses, by named key. `loadWorkflow` validates stateDir, so the run path
// still fails fast and reports err.message through exitUsage; `list` catches
// per file in describeWorkflowFile.
const requireTasksBase = () => getConfig.require('TASKS_BASE');
const { normalizeTicketArg } = require(path.join(__dirname, '..', 'lib', 'ticket-args'));
const safeTicketId = config.safeTicketId;
const { safeExec, computeScreenshotHash, buildInspectData } = require(
  path.join(__dirname, 'work-pr-inspect')
);
const { T, getRuntime } = require(path.join(__dirname, '..', 'lib', 'instruction-vocab'));

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTasksDir(ticketId) {
  return path.join(requireTasksBase(), safeTicketId(ticketId));
}

/**
 * The ticket worktree, or null when WORKTREES_BASE/REPO_NAME cannot resolve it.
 *
 * Null must never reach a command as `cwd`: child_process reads a null cwd as
 * "inherit", so `git rev-parse HEAD` would report on whatever repository the
 * process was launched in. Callers therefore check it — this does NOT throw,
 * because `onTransition` carries a never-throws contract (pinned by
 * "does not throw for any step combination") and a workflow definition that
 * throws from a transition hook takes the engine down with it.
 */
function getWorktreeDir(ticketId) {
  return config.worktreeDir(safeTicketId(ticketId));
}

// ─── Step deciders (detectStepState helpers) ────────────────────────────────

// Rebase guard: BLOCKED when the worktree is behind base beyond threshold.
function prGenRebaseBlock(d) {
  const parsed = parseInt(process.env.REBASE_GUARD_THRESHOLD || '0', 10);
  const threshold = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  if (d.commitsBehindMain > threshold) {
    return {
      action: 'BLOCKED',
      reason: `Worktree is ${d.commitsBehindMainCapped ? '>= ' : ''}${d.commitsBehindMain} commit(s) behind ${d.baseBranch || 'origin/main'}. Rebase before creating PR.`,
    };
  }
  return null;
}

// SHA-skip: compound key unchanged and not forced.
function prGenSkip(d, force) {
  if (!force && d.prUpToDate) {
    return {
      action: 'SKIP',
      reason: `Compound key matches (${d.headSha?.slice(0, 8)}|${d.screenshotHash?.slice(0, 8)})`,
    };
  }
  return null;
}

function prGenRunReason(d, force) {
  if (force) return 'Force mode — regenerating PR description';
  if (d.lastPrSha) return `Key changed: ${d.lastPrSha?.slice(0, 16)}… → ${d.prKey?.slice(0, 16)}…`;
  return 'No previous PR update recorded';
}

// 3_pr_gen: rebase-guard block → SHA-skip → run.
function decidePrGen(d, force) {
  return (
    prGenRebaseBlock(d) ||
    prGenSkip(d, force) || {
      action: 'RUN',
      reason: prGenRunReason(d, force),
      command: 'Task(pr-generator)',
    }
  );
}

// 4_screenshot_gate: skip unless TSX/JSX changed without screenshots.
function decideScreenshotGate(d) {
  if (!d.hasTsxChanges) {
    return { action: 'SKIP', reason: 'No TSX/JSX files changed' };
  }
  if (d.screenshotsExist) {
    return { action: 'SKIP', reason: `${d.screenshotCount} screenshot(s) found` };
  }
  return {
    action: 'RUN',
    reason: 'TSX/JSX changed but no screenshots — gate required',
    // Display label routed through the vocab map: 'AskUserQuestion' on
    // claude (byte-identical), 'request_user_input' on codex (C3).
    command: T('tool.question', {}, getRuntime().name),
  };
}

// 5_post_pr_gen: skip when no content or content SHA unchanged.
function decidePostPrGen(d, force) {
  if (!d.hasContent) {
    return { action: 'SKIP', reason: 'No content to post (no check reports or screenshots)' };
  }
  if (!force && d.postPrUpToDate) {
    return { action: 'SKIP', reason: 'Content SHA matches .post-pr-update-sha' };
  }
  return {
    action: 'RUN',
    reason: force
      ? 'Force mode — regenerating post-PR content'
      : d.lastPostPrSha
        ? 'Content changed since last run'
        : 'No previous post-PR update recorded',
    command: 'Task(pr-post-generator)',
  };
}

// ─── Workflow Definition ────────────────────────────────────────────────────

module.exports = {
  name: 'work-pr',
  command: '/work-pr',
  get stateDir() {
    return path.join(requireTasksBase());
  },

  steps: [
    { id: '1_preflight', name: 'Memory & zombie check', command: 'bash pre-flight script' },
    { id: '2_setup', name: 'Parse args, set variables', command: 'internal' },
    { id: '3_pr_gen', name: 'Run pr-generator', command: 'Task(pr-generator)' },
    { id: '4_screenshot_gate', name: 'Screenshot gate', command: 'internal + AskUserQuestion' },
    { id: '5_post_pr_gen', name: 'Run pr-post-generator', command: 'Task(pr-post-generator)' },
    { id: '6_summary', name: 'Print summary', command: 'internal' },
  ],

  transitions: [
    { source: '1_preflight', targets: ['2_setup'] },
    { source: '2_setup', targets: ['3_pr_gen', '4_screenshot_gate', '5_post_pr_gen', '6_summary'] },
    { source: '3_pr_gen', targets: ['4_screenshot_gate', '5_post_pr_gen', '6_summary'] },
    { source: '4_screenshot_gate', targets: ['5_post_pr_gen', '3_pr_gen', '6_summary'] },
    { source: '5_post_pr_gen', targets: ['6_summary'] },
    { source: '6_summary', targets: [] },
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
    const ticketId = normalizeTicketArg(parts[0]);

    return { instanceId: ticketId, ticketId, force };
  },

  /**
   * Inspect real filesystem state for an instance.
   * Uses the ticket-specific worktree directory for all git commands.
   * @param {string} instanceId - The ticket ID
   * @returns {object} Inspection data
   */
  inspect(instanceId) {
    return buildInspectData(getTasksDir(instanceId), getWorktreeDir(instanceId));
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
        return decidePrGen(d, force);
      case '4_screenshot_gate':
        return decideScreenshotGate(d);
      case '5_post_pr_gen':
        return decidePostPrGen(d, force);
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
      // Skip rather than run git with cwd:null, which child_process reads as
      // "inherit" — `git rev-parse HEAD` would then record the SHA of whatever
      // repository the process was launched in, and .pr-update-sha would gate
      // this ticket on another repo's HEAD.
      if (!worktreeDir) {
        process.stderr.write(
          `[work-pr] onTransition: cannot resolve the worktree for ${instanceId} ` +
            '(set WORKTREES_BASE and REPO_NAME) — skipping .pr-update-sha write\n'
        );
        return;
      }
      const headSha = safeExec('git rev-parse HEAD', { cwd: worktreeDir });
      if (!headSha) {
        process.stderr.write(
          `[work-pr] onTransition: cannot determine HEAD for ${instanceId} (worktree: ${worktreeDir}) — skipping .pr-update-sha write\n`
        );
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
