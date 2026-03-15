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
const TASKS_BASE = config.TASKS_BASE;
const REPO_DIR = config.repoDir();

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeExec(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', cwd: REPO_DIR, ...options }).trim();
  } catch {
    return '';
  }
}

// Use centralized getBaseBranch() from config
const getBaseBranch = config.getBaseBranch;

function getReportFolder(instanceId) {
  return path.join(TASKS_BASE, instanceId);
}

function getCurrentChangesHash() {
  const baseBranch = getBaseBranch();
  const diff = safeExec(`git diff ${baseBranch}...HEAD -w`);
  if (!diff) return 'no-changes';
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(diff).digest('hex').substring(0, 12);
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

  // If no direct app changes but packages changed, all web apps may be affected
  const webAppNames = config.webAppNames();
  if (apps.size === 0 && packages.size > 0 && webAppNames.length > 0) {
    return webAppNames;
  }

  return Array.from(apps).sort();
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
  return output.split('\n').some(line =>
    backendPatterns.some(pattern => pattern.test(line))
  );
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
    { id: '1_setup',             name: 'Setup & cache check',     command: 'node ~/.claude/hooks/check-setup.js' },
    { id: '2_start_env',         name: 'Start dev environment',   command: 'node ~/.claude/hooks/check-start-env.js' },
    { id: '3_verify_playwright', name: 'Verify Playwright',       command: 'mcp__playwright__browser_navigate' },
    { id: '4_phase1_agents',     name: 'Phase 1 parallel agents', command: 'Task(code-checker, quality-checker, qa-*, completion-checker)' },
    { id: '5_phase2_consensus',  name: 'Phase 2 consensus loop',  command: 'Task(developer-*, code-checker)' },
    { id: '6_quality_recheck',   name: 'Quality re-check',        command: 'Task(quality-checker) — affected files' },
    { id: '7_validate_summary',  name: 'Validate & generate summary', command: 'node check-validate-reports.js + check-generate-summary.js' },
    { id: '8_output',            name: 'Final output',            command: 'internal' },
    { id: '9_cleanup',           name: 'Cleanup',                 command: 'internal — kill dev servers' },
  ],

  transitions: [
    { source: '1_setup',             targets: ['2_start_env', '8_output'] },
    { source: '2_start_env',         targets: ['3_verify_playwright'] },
    { source: '3_verify_playwright', targets: ['4_phase1_agents', '8_output'] },
    { source: '4_phase1_agents',     targets: ['5_phase2_consensus', '7_validate_summary'] },
    { source: '5_phase2_consensus',  targets: ['6_quality_recheck', '7_validate_summary'] },
    { source: '6_quality_recheck',   targets: ['7_validate_summary'] },
    { source: '7_validate_summary',  targets: ['8_output'] },
    { source: '8_output',            targets: ['9_cleanup'] },
    { source: '9_cleanup',           targets: [] },
  ],

  /**
   * Parse CLI arguments into workflow params.
   * Accepts: "PROJ-856", "856", "" (uses branch name)
   */
  params(args) {
    const raw = args.trim();
    let ticketId = raw;

    if (!ticketId) {
      // Use branch name as fallback
      ticketId = safeExec('git branch --show-current') || 'unknown';
    } else if (/^\d+$/.test(ticketId)) {
      ticketId = `${process.env.TICKET_PROJECT_KEY || process.env.JIRA_PROJECT_KEY || 'PROJ'}-${ticketId}`;
    }

    ticketId = ticketId.toUpperCase();

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
      } catch { /* */ }
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

    // QA reports per impacted app
    data.qaReports = {};
    for (const app of impactedApps) {
      const filename = `qa-${app}.check.md`;
      data.qaReports[app] = {
        exists: fs.existsSync(path.join(reportFolder, filename)),
        hashMatch: reportHasMatchingHash(reportFolder, filename, changesHash),
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
    data.replyHashMatch = reportHasMatchingHash(reportFolder, 'code-review-reply.check.md', changesHash);
    data.consensusLogExists = fs.existsSync(path.join(reportFolder, 'code-review-consensus-log.md'));
    data.replyHasImplementations = codeReviewReplyHasImplementations(reportFolder);

    // Missing Phase 1 reports
    const missingReports = [];
    for (const [name, info] of Object.entries(data.reports)) {
      if (!info.hashMatch) missingReports.push(name);
    }
    for (const [app, info] of Object.entries(data.qaReports)) {
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

    switch (stepId) {
      case '1_setup':
        return { action: 'RUN', reason: 'Initialize variables and check cache' };

      case '2_start_env':
        if (d.readmeHashMatch) {
          return { action: 'SKIP', reason: `Cache valid — hash ${d.changesHash} matches README.md` };
        }
        return {
          action: 'RUN',
          reason: `Start dev environment for ${d.impactedApps?.length || 0} app(s)`,
          command: 'node ~/.claude/hooks/check-start-env.js',
        };

      case '3_verify_playwright':
        if (d.readmeHashMatch) {
          return { action: 'SKIP', reason: 'Cache valid — skipping Playwright check' };
        }
        return {
          action: 'RUN',
          reason: 'Verify Playwright MCP connectivity before launching QA agents',
          command: 'mcp__playwright__browser_navigate',
        };

      case '4_phase1_agents':
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

      case '5_phase2_consensus':
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

      case '6_quality_recheck':
        if (!d.replyHasImplementations) {
          return { action: 'SKIP', reason: 'No IMPLEMENTED suggestions in reply — no re-check needed' };
        }
        return {
          action: 'RUN',
          reason: 'Developer(s) implemented suggestions — re-validate affected files',
          command: 'Task(quality-checker)',
        };

      case '7_validate_summary':
        if (d.readmeHashMatch) {
          return { action: 'SKIP', reason: 'Cache valid — summary already generated' };
        }
        return {
          action: 'RUN',
          reason: 'Validate reports and generate README.md summary',
          command: 'node check-validate-reports.js + check-generate-summary.js',
        };

      case '8_output':
        return { action: 'RUN', reason: 'Display final results to user' };

      case '9_cleanup':
        if (d.readmeHashMatch) {
          return { action: 'SKIP', reason: 'Cache valid — no environment was started' };
        }
        return { action: 'RUN', reason: 'Stop dev servers and cleanup resources' };

      default:
        return { action: 'RUN', reason: 'Unknown step' };
    }
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
