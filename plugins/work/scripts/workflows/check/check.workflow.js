#!/usr/bin/env node

/**
 * check.workflow.js
 *
 * Workflow definition for the /check command.
 * Orchestrates full quality verification with parallel agents, consensus loops,
 * and cache-based skip detection.
 *
 * Steps:
 *   1. Setup & cache check
 *   2. Start dev environment
 *   3. Verify Playwright
 *   4. Phase 1 parallel agents (code-checker, quality-checker, QA, completion-checker)
 *   5. Phase 2 consensus loop (developer(s) + code-checker validation)
 *   6. Quality re-check (affected files only)
 *   7. Validate & generate summary
 *   8. Final output
 *   9. Cleanup
 */

const fs = require('fs');
const path = require('path');

// ─── Constants ──────────────────────────────────────────────────────────────

const config = require(path.join(__dirname, '..', 'lib', 'config'));
const { normalizeTicketId } = require(path.join(__dirname, '..', 'lib', 'ticket-provider'));
const { normalizeTicketArg } = require(path.join(__dirname, '..', 'lib', 'ticket-args'));
const TASKS_BASE = config.TASKS_BASE;
const REPO_DIR = config.repoDir();

// ─── Helpers ────────────────────────────────────────────────────────────────

const STEP_STATE_DETECTORS = {
  '1_setup': () => ({ action: 'RUN', reason: 'Initialize variables and check cache' }),

  '2_start_env': (d) => {
    if (d.readmeHashMatch) {
      return {
        action: 'SKIP',
        reason: `Cache valid — hash ${d.changesHash} matches README.md`,
      };
    }
    return {
      action: 'RUN',
      reason: `Start dev environment for ${d.impactedApps?.length || 0} app(s)`,
      command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/check-start-env.js"',
    };
  },

  '3_verify_playwright': (d) => {
    if (d.readmeHashMatch) {
      return { action: 'SKIP', reason: 'Cache valid — skipping Playwright check' };
    }
    if (d.hasWebApps === false) {
      return { action: 'SKIP', reason: 'No web apps configured — Playwright not needed' };
    }
    return {
      action: 'RUN',
      reason: 'Verify Playwright MCP connectivity before launching QA agents',
      command: 'mcp__playwright__browser_navigate',
    };
  },

  '4_phase1_agents': (d) => {
    if (d.allPhase1ReportsMatch) {
      return {
        action: 'SKIP',
        reason: `All Phase 1 reports exist with matching hash (${d.changesHash})`,
      };
    }
    return {
      action: 'RUN',
      reason: d.missingReports?.length
        ? `Missing/stale reports: ${d.missingReports.join(', ')}`
        : 'Run all Phase 1 agents',
      command: 'Task(code-checker, quality-checker, qa-*, completion-checker)',
    };
  },

  '5_phase2_consensus': (d) => {
    if (!d.codeReviewHasSuggestions) {
      return { action: 'SKIP', reason: 'No suggestions in code-review.check.md' };
    }
    if (d.replyExists && d.replyHashMatch && d.consensusLogExists) {
      return {
        action: 'SKIP',
        reason: 'code-review-reply.check.md and consensus log exist with matching hash',
      };
    }
    return {
      action: 'RUN',
      reason: 'Code review has suggestions — developers must evaluate',
      command: 'Task(developer-*, code-checker)',
    };
  },

  '6_quality_recheck': (d) => {
    if (!d.replyHasImplementations) {
      return {
        action: 'SKIP',
        reason: 'No IMPLEMENTED suggestions in reply — no re-check needed',
      };
    }
    return {
      action: 'RUN',
      reason: 'Developer(s) implemented suggestions — re-validate affected files',
      command: 'Task(quality-checker)',
    };
  },

  '7_validate_summary': (d) => {
    if (d.readmeHashMatch) {
      return { action: 'SKIP', reason: 'Cache valid — summary already generated' };
    }
    return {
      action: 'RUN',
      reason: 'Validate reports and generate README.md summary',
      command: 'node check-validate-reports.js + check-generate-summary.js',
    };
  },

  '8_output': () => ({ action: 'RUN', reason: 'Display final results to user' }),

  '9_cleanup': (d) => {
    if (d.readmeHashMatch) {
      return { action: 'SKIP', reason: 'Cache valid — no environment was started' };
    }
    return { action: 'RUN', reason: 'Stop dev servers and cleanup resources' };
  },
};

// Filesystem/git inspection helpers live in lib/workflow-inspect.js
const {
  safeExec,
  getCurrentChangesHash,
  getCurrentHeadSha,
  inspectCheckState,
  completedStaleCheck,
} = require(path.join(__dirname, 'lib', 'workflow-inspect'));

// ─── Workflow Definition ────────────────────────────────────────────────────

module.exports = {
  name: 'check',
  command: '/check',
  stateDir: TASKS_BASE,

  steps: [
    {
      id: '1_setup',
      name: 'Setup & cache check',
      command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/check-setup.js"',
    },
    {
      id: '2_start_env',
      name: 'Start dev environment',
      command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/check-start-env.js"',
    },
    {
      id: '3_verify_playwright',
      name: 'Verify Playwright',
      command: 'mcp__playwright__browser_navigate',
    },
    {
      id: '4_phase1_agents',
      name: 'Phase 1 parallel agents',
      command: 'Task(code-checker, quality-checker, qa-*, completion-checker)',
    },
    {
      id: '5_phase2_consensus',
      name: 'Phase 2 consensus loop',
      command: 'Task(developer-*, code-checker)',
    },
    {
      id: '6_quality_recheck',
      name: 'Quality re-check',
      command: 'Task(quality-checker) — affected files',
    },
    {
      id: '7_validate_summary',
      name: 'Validate & generate summary',
      command: 'node check-validate-reports.js + check-generate-summary.js',
    },
    { id: '8_output', name: 'Final output', command: 'internal' },
    { id: '9_cleanup', name: 'Cleanup', command: 'internal — kill dev servers' },
  ],

  transitions: [
    { source: '1_setup', targets: ['2_start_env', '8_output'] },
    { source: '2_start_env', targets: ['3_verify_playwright', '4_phase1_agents'] },
    { source: '3_verify_playwright', targets: ['4_phase1_agents', '8_output'] },
    { source: '4_phase1_agents', targets: ['5_phase2_consensus', '7_validate_summary'] },
    { source: '5_phase2_consensus', targets: ['6_quality_recheck', '7_validate_summary'] },
    { source: '6_quality_recheck', targets: ['7_validate_summary'] },
    { source: '7_validate_summary', targets: ['8_output'] },
    { source: '8_output', targets: ['9_cleanup'] },
    { source: '9_cleanup', targets: [] },
  ],

  /**
   * GH-307: SHA-anchored staleness check for a `status: completed` instance
   * (see lib/workflow-inspect.js). `probes` is a test-injection point.
   */
  completedStaleCheck(instanceId, state, probes = {}) {
    return completedStaleCheck(instanceId, state, probes);
  },

  /**
   * GH-307: record completion SHAs when the workflow reaches its terminal
   * step (the engine flips status → completed on transition INTO 9_cleanup).
   */
  onTransition(fromStep, toStep, instanceId, { stateInstance }) {
    if (toStep !== '9_cleanup') return;
    const st = stateInstance.load(instanceId);
    if (!st) return;
    st.completedChangesHash = getCurrentChangesHash();
    st.completedHeadSha = getCurrentHeadSha();
    st.completedAt = new Date().toISOString();
    stateInstance.save(instanceId, st);
  },

  /**
   * Parse CLI arguments into workflow params.
   * Accepts: "PROJ-856", "856", "" (uses branch name)
   */
  params(args) {
    const raw = args.trim();
    if (!raw) {
      // Use branch name as fallback (not project-key prefixed)
      const ticketId = normalizeTicketId(safeExec('git branch --show-current') || 'unknown');
      return { instanceId: ticketId, ticketId };
    }
    const ticketId = normalizeTicketArg(raw);
    return { instanceId: ticketId, ticketId };
  },

  /**
   * Inspect real filesystem state for cache/skip detection
   * (see lib/workflow-inspect.js).
   */
  inspect(instanceId) {
    return inspectCheckState(instanceId);
  },

  /**
   * Determine step action (RUN/SKIP) for each step.
   */
  detectStepState(stepId, instanceId, state, inspectData) {
    const d = inspectData || {};
    const detector = STEP_STATE_DETECTORS[stepId];
    if (!detector) return { action: 'RUN', reason: 'Unknown step' };
    return detector(d);
  },

  /** Extra fields to include in initial state */
  extraStateFields: {
    changesHash: null,
    reportFolder: null,
    impactedApps: [],
    runningApps: {},
    involvedDevelopers: [],
    consensusIterations: 0,
    playwrightVerified: false,
  },
};
