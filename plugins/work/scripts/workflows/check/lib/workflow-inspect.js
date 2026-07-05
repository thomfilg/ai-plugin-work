'use strict';

/**
 * check/lib/workflow-inspect.js — filesystem/git inspection helpers for
 * check.workflow.js (extracted from the workflow definition).
 *
 * Owns the cache-detection primitives (changes hash, report-hash matching),
 * the `inspect()` state snapshot, and the GH-307 completed-staleness check.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const config = require(path.join(__dirname, '..', '..', 'lib', 'config'));
const { discoverApps } = require(path.join(__dirname, 'app-access'));

const TASKS_BASE = config.TASKS_BASE;
const REPO_DIR = config.repoDir();

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

// ─── inspect() snapshot ─────────────────────────────────────────────────────

/** README.md cache check. */
function collectReadmeCache(data, reportFolder, changesHash) {
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
}

/** Per-report existence with hash matching + QA reports per impacted app. */
function collectReportStates(data, reportFolder, changesHash, impactedApps) {
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
}

/** Phase 2 (consensus loop) state. */
function collectPhase2State(data, reportFolder, changesHash) {
  data.codeReviewHasSuggestions = codeReviewHasSuggestions(reportFolder);
  data.replyExists = fs.existsSync(path.join(reportFolder, 'code-review-reply.check.md'));
  data.replyHashMatch = reportHasMatchingHash(
    reportFolder,
    'code-review-reply.check.md',
    changesHash
  );
  data.consensusLogExists = fs.existsSync(path.join(reportFolder, 'code-review-consensus-log.md'));
  data.replyHasImplementations = codeReviewReplyHasImplementations(reportFolder);
}

/** Missing Phase 1 reports (stale or absent). */
function collectMissingReports(data) {
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
}

/**
 * Inspect real filesystem state for cache/skip detection.
 */
function inspectCheckState(instanceId) {
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

  collectReadmeCache(data, reportFolder, changesHash);
  collectReportStates(data, reportFolder, changesHash, impactedApps);
  collectPhase2State(data, reportFolder, changesHash);
  collectMissingReports(data);

  return data;
}

// ─── GH-307 completed-staleness check ───────────────────────────────────────

/** SHA-drift reasons from the recorded completion SHAs. */
function collectCompletionShaDrift(state, currentHash, currentHead, recordedHash) {
  const reasons = [];
  if (recordedHash && currentHash && currentHash !== recordedHash) {
    reasons.push(`sha-drift: changes hash ${recordedHash} → ${currentHash}`);
  }
  if (state.completedHeadSha && currentHead && currentHead !== state.completedHeadSha) {
    reasons.push(`sha-drift: HEAD ${state.completedHeadSha} → ${currentHead}`);
  }
  return reasons;
}

/**
 * Stale-report check: a report left over from a previous cycle whose
 * Changes Hash no longer matches the current diff (see GH-329).
 * Legacy fallback: no completion SHAs recorded at all — anchor on README.
 */
function collectReportDrift(folder, currentHash, recordedHash, state) {
  const reasons = [];
  for (const report of ['tests.check.md', 'code-review.check.md', 'completion.check.md']) {
    if (
      fs.existsSync(path.join(folder, report)) &&
      !reportHasMatchingHash(folder, report, currentHash)
    ) {
      reasons.push(`sha-drift: ${report} Changes Hash does not match current ${currentHash}`);
      break;
    }
  }
  if (reasons.length === 0 && !recordedHash && !state.completedHeadSha) {
    if (!reportHasMatchingHash(folder, 'README.md', currentHash)) {
      reasons.push(
        `sha-drift: no completion SHAs recorded and README.md hash does not match current ${currentHash}`
      );
    }
  }
  return reasons;
}

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
function completedStaleCheck(instanceId, state, probes = {}) {
  const currentHash =
    probes.currentHash !== undefined ? probes.currentHash : getCurrentChangesHash();
  const currentHead = probes.currentHead !== undefined ? probes.currentHead : getCurrentHeadSha();

  const recordedHash = state.completedChangesHash || state.changesHash || null;
  const reasons = collectCompletionShaDrift(state, currentHash, currentHead, recordedHash);

  if (reasons.length === 0 && currentHash) {
    const folder = probes.reportFolder || getReportFolder(instanceId);
    reasons.push(...collectReportDrift(folder, currentHash, recordedHash, state));
  }

  return { stale: reasons.length > 0, reasons, currentHash, currentHead };
}

module.exports = {
  safeExec,
  getBaseBranch,
  getReportFolder,
  getCurrentChangesHash,
  getCurrentHeadSha,
  reportHasMatchingHash,
  getImpactedApps,
  getQaAgentForApp,
  hasBackendChanges,
  codeReviewHasSuggestions,
  codeReviewReplyHasImplementations,
  inspectCheckState,
  completedStaleCheck,
};
