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
const { execSync } = require('child_process');

// ─── Constants ──────────────────────────────────────────────────────────────

const config = require(path.join(__dirname, '..', 'lib', 'config'));
const { normalizeTicketId } = require(path.join(__dirname, '..', 'lib', 'ticket-provider'));
const { normalizeTicketArg } = require(path.join(__dirname, '..', 'lib', 'ticket-args'));
const { discoverApps } = require(path.join(__dirname, 'lib', 'app-access'));
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

function safeExec(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', cwd: REPO_DIR, ...options }).trim();
  } catch {
    return '';
  }
}

// Use centralized getBaseBranch() from config, bound to repo directory
const getBaseBranch = () => config.getBaseBranch({ cwd: REPO_DIR });

function getReportFolder(instanceId) {
  return config.tasksDir(instanceId) || path.join(TASKS_BASE, instanceId);
}

function getCurrentChangesHash() {
  const baseBranch = getBaseBranch();
  const diff = safeExec(`git diff ${baseBranch}...HEAD -w`);
  if (!diff) return 'no-changes';
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(diff).digest('hex').substring(0, 12);
}

function getCurrentHeadSha() {
  const sha = safeExec('git rev-parse HEAD');
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

function reportHasMatchingHash(folder, filename, hash) {
  const filePath = path.join(folder, filename);
  if (!fs.existsSync(filePath)) return false;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/\*\*Changes Hash:\*\*\s*([a-f0-9]{12}|no-changes)/);
    return match && match[1] === hash;
  } catch {
    return false;
  }
}

function getImpactedApps() {
  const baseBranch = getBaseBranch();
  const output = safeExec(`git diff --name-only ${baseBranch}...HEAD`);
  if (!output) return [];
  const apps = new Set();
  const packages = new Set();
  for (const line of output.split('\n')) {
    const appMatch = line.match(/^apps\/([^/]+)\//);
    if (appMatch) apps.add(appMatch[1]);
    const pkgMatch = line.match(/^packages\/([^/]+)\//);
    if (pkgMatch) packages.add(pkgMatch[1]);
  }

  // If no direct app changes but packages changed, use discoverApps() manifest
  // to determine which apps may be affected (replaces hardcoded WEB_APPS list)
  const manifestApps = discoverApps();
  if (apps.size === 0 && packages.size > 0 && manifestApps.length > 0) {
    return manifestApps.map((a) => a.name).sort();
  }

  return Array.from(apps).sort();
}

/**
 * Get the QA agent type for an app based on its appType from the manifest.
 * @param {string} appName - Name of the app
 * @returns {{ agent: string, skip: boolean }} Agent to dispatch or skip flag
 */
function getQaAgentForApp(appName, manifestApps) {
  const apps = manifestApps || discoverApps();
  const entry = apps.find((a) => a.name === appName);
  const appType = entry?.appType || 'web';

  switch (appType) {
    case 'web':
      return { agent: 'qa-feature-tester', skip: false };
    case 'api':
      return { agent: 'qa-api-tester', skip: false };
    case 'cli':
      return { agent: null, skip: true };
    default:
      return { agent: 'qa-feature-tester', skip: false };
  }
}

function hasBackendChanges() {
  const baseBranch = getBaseBranch();
  const output = safeExec(`git diff --name-only ${baseBranch}...HEAD`);
  if (!output) return false;
  const backendPatterns = [
    /worker\//,
    /src\/routes\//,
    /src\/api\//,
    /src\/services\//,
    /src\/controllers\//,
    /src\/middleware\//,
    /\.sql$/,
    /migrations\//,
  ];
  return output.split('\n').some((line) => backendPatterns.some((pattern) => pattern.test(line)));
}

function codeReviewHasSuggestions(folder) {
  const filePath = path.join(folder, 'code-review.check.md');
  if (!fs.existsSync(filePath)) return false;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return /🟡|🟢/.test(content);
  } catch {
    return false;
  }
}

function codeReviewReplyHasImplementations(folder) {
  const filePath = path.join(folder, 'code-review-reply.check.md');
  if (!fs.existsSync(filePath)) return false;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return /IMPLEMENTED/i.test(content);
  } catch {
    return false;
  }
}

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
   * GH-307: SHA-anchored staleness check for a `status: completed` instance.
   * Called by workflow-engine before planning when prior state is completed.
   * Reset is authorized ONLY when a SHA condition proves the inputs changed
   * (enforcement, not bypass):
   *   1. current changes hash differs from the hash recorded at completion
   *   2. current HEAD differs from the HEAD recorded at completion
   *   3. any report's `**Changes Hash:**` header doesn't match the current hash
   * Legacy states without recorded completion SHAs fall back to the README
   * hash comparison. `probes` is a test-injection point.
   *
   * @returns {{stale: boolean, reasons: string[], currentHash: string, currentHead: string|null}}
   */
  completedStaleCheck(instanceId, state, probes = {}) {
    const currentHash =
      probes.currentHash !== undefined ? probes.currentHash : getCurrentChangesHash();
    const currentHead = probes.currentHead !== undefined ? probes.currentHead : getCurrentHeadSha();
    const reasons = [];

    const recordedHash = state.completedChangesHash || state.changesHash || null;
    if (recordedHash && currentHash && currentHash !== recordedHash) {
      reasons.push(`sha-drift: changes hash ${recordedHash} → ${currentHash}`);
    }
    if (state.completedHeadSha && currentHead && currentHead !== state.completedHeadSha) {
      reasons.push(`sha-drift: HEAD ${state.completedHeadSha} → ${currentHead}`);
    }

    // Stale-report check: a report left over from a previous cycle whose
    // Changes Hash no longer matches the current diff (see GH-329).
    if (reasons.length === 0 && currentHash) {
      const folder = probes.reportFolder || getReportFolder(instanceId);
      for (const report of ['tests.check.md', 'code-review.check.md', 'completion.check.md']) {
        if (
          fs.existsSync(path.join(folder, report)) &&
          !reportHasMatchingHash(folder, report, currentHash)
        ) {
          reasons.push(`sha-drift: ${report} Changes Hash does not match current ${currentHash}`);
          break;
        }
      }
      // Legacy fallback: no completion SHAs recorded at all — anchor on README.
      if (reasons.length === 0 && !recordedHash && !state.completedHeadSha) {
        if (!reportHasMatchingHash(folder, 'README.md', currentHash)) {
          reasons.push(
            `sha-drift: no completion SHAs recorded and README.md hash does not match current ${currentHash}`
          );
        }
      }
    }

    return { stale: reasons.length > 0, reasons, currentHash, currentHead };
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
   * Inspect real filesystem state for cache/skip detection.
   */
  inspect(instanceId) {
    const reportFolder = getReportFolder(instanceId);
    const changesHash = getCurrentChangesHash();
    const impactedApps = getImpactedApps();

    const data = {
      reportFolder,
      reportFolderExists: fs.existsSync(reportFolder),
      changesHash,
      impactedApps,
      hasBackendChanges: hasBackendChanges(),
      hasWebApps: config.webAppNames().length > 0,
    };

    // README.md cache check
    const readmePath = path.join(reportFolder, 'README.md');
    data.readmeExists = fs.existsSync(readmePath);
    data.readmeHashMatch = false;
    if (data.readmeExists) {
      try {
        const content = fs.readFileSync(readmePath, 'utf8');
        const match = content.match(/\*\*Changes Hash:\*\*\s*([a-f0-9]{12}|no-changes)/);
        data.readmeHashMatch = match && match[1] === changesHash;
      } catch {
        /* */
      }
    }

    // Per-report existence with hash matching
    const reports = ['code-review.check.md', 'tests.check.md', 'completion.check.md'];
    data.reports = {};
    for (const report of reports) {
      data.reports[report] = {
        exists: fs.existsSync(path.join(reportFolder, report)),
        hashMatch: reportHasMatchingHash(reportFolder, report, changesHash),
      };
    }

    // QA reports per impacted app (with appType routing)
    const manifestApps = discoverApps();
    data.qaReports = {};
    for (const app of impactedApps) {
      const routing = getQaAgentForApp(app, manifestApps);
      const filename = `qa-${app}.check.md`;
      data.qaReports[app] = {
        exists: fs.existsSync(path.join(reportFolder, filename)),
        hashMatch: reportHasMatchingHash(reportFolder, filename, changesHash),
        agent: routing.agent,
        skip: routing.skip,
      };
    }

    // API report
    data.apiReport = {
      exists: fs.existsSync(path.join(reportFolder, 'qa-api.check.md')),
      hashMatch: reportHasMatchingHash(reportFolder, 'qa-api.check.md', changesHash),
    };

    // Phase 2 state
    data.codeReviewHasSuggestions = codeReviewHasSuggestions(reportFolder);
    data.replyExists = fs.existsSync(path.join(reportFolder, 'code-review-reply.check.md'));
    data.replyHashMatch = reportHasMatchingHash(
      reportFolder,
      'code-review-reply.check.md',
      changesHash
    );
    data.consensusLogExists = fs.existsSync(
      path.join(reportFolder, 'code-review-consensus-log.md')
    );
    data.replyHasImplementations = codeReviewReplyHasImplementations(reportFolder);

    // Missing Phase 1 reports
    const missingReports = [];
    for (const [name, info] of Object.entries(data.reports)) {
      if (!info.hashMatch) missingReports.push(name);
    }
    for (const [app, info] of Object.entries(data.qaReports)) {
      if (info.skip) continue; // cli apps don't produce QA reports
      if (!info.hashMatch) missingReports.push(`qa-${app}.check.md`);
    }
    if (data.hasBackendChanges && !data.apiReport.hashMatch) {
      missingReports.push('qa-api.check.md');
    }
    data.missingReports = missingReports;
    data.allPhase1ReportsMatch = missingReports.length === 0;

    return data;
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
