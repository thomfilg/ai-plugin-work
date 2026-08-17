#!/usr/bin/env node
/**
 * /check Setup Script
 *
 * Handles:
 * - Determining worktree path and report folder
 * - Generating CHANGES_HASH from git diff
 * - Checking if reports are up-to-date (cache validation)
 * - Creating folders and cleaning old files
 * - Analyzing impacted apps
 *
 * Usage: node check-setup.js [TICKET_ID]
 *
 * Output: JSON object with setup variables
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require(path.join(__dirname, '..', '..', 'lib', 'config'));

/**
 * Resolve ticket ID from CLI args and environment.
 * Precedence: CLI arg > TICKET_ID env > JIRA_TICKET_ID env (backward compat)
 * See hooks/__tests__/check-setup-ticket-id.test.js for coverage.
 */
function resolveTicketId(argv = [], env = {}) {
  return argv[0] || env.TICKET_ID || env.JIRA_TICKET_ID || '';
}

const TICKET_ID = resolveTicketId(process.argv.slice(2), process.env);

// Shared shell helper (also used by lib/impacted-apps.js)
const { exec } = require(path.join(__dirname, '..', 'lib', 'exec-util'));

// echo-6842: the orchestrator can invalidate the check evidence without the
// diff changing, and this cache must honour that — see checkReportsCache.
const { isEvidenceStale } = require(
  path.join(__dirname, '..', '..', 'work', 'lib', 'evidence-staleness')
);
const { STEPS } = require(path.join(__dirname, '..', '..', 'work', 'step-registry'));

// TASKS_BASE comes from the SAME resolver check-next.js uses, so both halves of
// /check land in one directory. `config.tasksDir()` is deliberately NOT used:
// config.js still derives TASKS_BASE from WORKTREES_BASE when the env is absent
// (lib/config.js `config.TASKS_BASE = ... path.join(WORKTREES_BASE, 'tasks')`),
// which is the guess resolve-base-dirs.js was written to refuse — reaching for
// it here would rebuild the very split this resolves.
const { resolvePluginConfig } = require(path.join(__dirname, '..', '..', 'lib', 'plugin-config'));
const { validateTicketIdStructured } = require(
  path.join(__dirname, '..', '..', 'lib', 'ticket-validation')
);

// Use centralized getBaseBranch() from config
const getBaseBranch = config.getBaseBranch;

/**
 * Get the main worktree path
 */
function getMainWorktreePath() {
  const output = exec('git worktree list');
  const firstLine = output.split('\n')[0];
  return firstLine.split(/\s+/)[0];
}

/**
 * Get current branch name
 */
function getBranchName() {
  return exec('git branch --show-current');
}

/**
 * Generate hash from changed file contents
 * Same changes = same hash, any line change = different hash
 * Uses -w to ignore whitespace-only changes
 */
function generateChangesHash() {
  // Use -w to ignore whitespace changes (prevents false cache misses)
  const baseBranch = getBaseBranch();
  const diff = exec(`git diff ${baseBranch}...HEAD -w`);
  if (!diff) {
    // No changes, use empty hash
    return 'no-changes';
  }

  // Use Node's crypto for hashing
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(diff).digest('hex');
  return hash.substring(0, 12);
}

/**
 * Check if reports are up-to-date by comparing hashes.
 *
 * echo-6842: the hash is a whitespace-insensitive diff against the base
 * branch, so HEAD can move without moving it — a rebase, an amend, an empty
 * or whitespace-only commit. The orchestrator's check-drift gate keys off the
 * HEAD SHA instead, so those are exactly the cases where it invalidates the
 * check evidence and asks for a re-run. If the cache still reported a hit,
 * /check would skip the agents, no report would be rewritten, the mark would
 * never clear, and the workflow would sit at check forever — the deadlock
 * this cache would otherwise re-introduce one layer down. An invalidated
 * step is therefore always a cache miss.
 *
 * The reports are not lost by that miss: `shouldPurgeReports` is keyed on the
 * same unchanged hash, so the cycle marker still matches and the purge is
 * skipped. The agents simply run again and overwrite.
 */
function checkReportsCache(reportFolder, currentHash) {
  const readmePath = path.join(reportFolder, 'README.md');

  if (isEvidenceStale(reportFolder, STEPS.check)) {
    return { cached: false, reason: 'Check evidence invalidated by the orchestrator' };
  }

  if (!fs.existsSync(readmePath)) {
    return { cached: false, reason: 'No README.md found' };
  }

  const content = fs.readFileSync(readmePath, 'utf8');
  const match = content.match(/\*\*Changes Hash:\*\*\s*([a-f0-9]{12}|no-changes)/);

  if (!match) {
    return { cached: false, reason: 'No hash found in README.md' };
  }

  const cachedHash = match[1];

  if (cachedHash === currentHash) {
    return {
      cached: true,
      cachedHash,
      readme: content,
    };
  }

  return {
    cached: false,
    reason: 'Hash mismatch',
    previousHash: cachedHash,
    currentHash,
  };
}

// Report-folder lifecycle (cycle marker, purge guard, folder setup) lives in
// ../lib/report-cycle.js; re-exported below for the existing callers.
const { shouldPurgeReports, setupReportFolder } = require(
  path.join(__dirname, '..', 'lib', 'report-cycle')
);

// Impacted-app / affected-file analysis lives in ../lib/impacted-apps.js
const { getImpactedApps, getAffectedFiles } = require(
  path.join(__dirname, '..', 'lib', 'impacted-apps')
);

// Docs loading (READ_DOCS_ON_*) lives in ../lib/load-docs.js
const { loadDocsFromPaths, DOCS_DENYLIST } = require(
  path.join(__dirname, '..', 'lib', 'load-docs')
);

/**
 * The pre-fix layout: `<mainWorktree>/../tasks/<id>`. Tickets checked before
 * the TASKS_BASE fix have reports stranded there and nothing reads that
 * directory any more. Report it when it still holds check artifacts so the
 * leftovers stay discoverable.
 *
 * Strictly informational — this never moves, copies or deletes anything, and
 * never blocks a run. Copying them into TASKS_BASE would be worse than leaving
 * them: they would land where the check gate reads and pass as current
 * evidence for code that has since moved on.
 */
function findLegacyReportFolder(mainWorktreePath, taskId, reportFolder) {
  if (!mainWorktreePath) return null;
  const legacy = path.join(mainWorktreePath, '..', 'tasks', taskId);
  if (path.resolve(legacy) === path.resolve(reportFolder)) return null;
  try {
    const stranded = fs.readdirSync(legacy).some((f) => f.endsWith('.check.md'));
    return stranded ? path.resolve(legacy) : null;
  } catch {
    return null; // absent or unreadable — nothing to report
  }
}

/** Branch name reduced to a safe single path segment. */
function branchFallbackId(branchName) {
  return String(branchName || '').replace(/[^a-zA-Z0-9._-]/g, '-');
}

/**
 * Derive taskId from TICKET_ID or branch name fallback.
 *
 * The leaf must match the orchestrator's or the base fix below only moves the
 * split: check-next.js keys its dir on `tp.sanitizeTicketIdForPath(ticket)`, so
 * this normalises through the same sanitiser (`config.safeTicketId` is that
 * function with a cached provider config). Previously a GitHub `#279` failed
 * this function's hand-rolled character test and silently became the BRANCH
 * NAME, while the orchestrator used `GH-279`.
 *
 * Validation then goes through the shared `validateTicketIdStructured` — the
 * same rule allocate-output-folder and request-index apply — which rejects
 * traversal, absolute paths, empty ids and multi-slash suffixes. A suffix like
 * `GH-181/phase1` still passes and still creates a subdirectory (GH-181).
 * Anything rejected falls back to the sanitized branch name, as before.
 */
function deriveTaskId(ticketId, branchName) {
  if (!ticketId) return branchFallbackId(branchName);
  const safeId = config.safeTicketId(ticketId);
  if (validateTicketIdStructured(safeId)) return branchFallbackId(branchName);
  return safeId;
}

/**
 * READ_DOCS_ON_* content per agent type. Every key is always present so the
 * emitted JSON keeps a stable schema. Resolved against the CURRENT worktree
 * root (not the main worktree) so docs reflect the feature branch.
 */
function loadAgentDocs() {
  const docVars = [
    'READ_DOCS_ON_REVIEW',
    'READ_DOCS_ON_QA',
    'READ_DOCS_ON_DEV',
    'READ_DOCS_ON_E2E',
    'READ_DOCS_ON_TEST',
    'READ_DOCS_ON_STORYBOOK',
    'READ_DOCS_ON_PR',
  ];
  const currentRepoRoot = exec('git rev-parse --show-toplevel') || process.cwd();
  const loaded = {};
  for (const varName of docVars) {
    const key = varName.replace('READ_DOCS_ON_', '').toLowerCase() + 'Docs';
    loaded[key] = loadDocsFromPaths(varName, config[varName], currentRepoRoot);
  }
  return loaded;
}

/**
 * Resolve the ticket's report folder from the configured TASKS_BASE — NOT from
 * the worktree layout. `<mainWorktree>/../tasks/<id>` landed on a sibling of
 * the worktrees dir, so /check wrote its reports somewhere the orchestrator
 * never looked: state in `<TASKS_BASE>/<id>/`, reports in
 * `<worktrees>/tasks/<id>/`, and gates reporting "Missing report:
 * tests.check.md" for files one directory over.
 *
 * Refuses rather than guessing when TASKS_BASE is unset — a wrong-but-plausible
 * path is what caused that.
 *
 * @returns {{reportFolder: string}|{error: string}}
 */
function resolveReportFolder(taskId) {
  const { TASKS_BASE, configError } = resolvePluginConfig(path.join(__dirname, '..', '..', 'work'));
  if (!TASKS_BASE) return { error: configError || 'TASKS_BASE not configured' };
  return { reportFolder: path.join(TASKS_BASE, taskId) };
}

/**
 * Main execution
 */
function main() {
  const mainWorktreePath = getMainWorktreePath();
  const branchName = getBranchName();
  const taskId = deriveTaskId(TICKET_ID, branchName);

  const resolved = resolveReportFolder(taskId);
  if (resolved.error) {
    console.log(JSON.stringify({ error: resolved.error }, null, 2));
    process.exitCode = 1;
    return;
  }
  const { reportFolder } = resolved;

  const changesHash = generateChangesHash();
  const cacheResult = checkReportsCache(reportFolder, changesHash);
  const impactedApps = getImpactedApps();
  const affectedFiles = getAffectedFiles(); // for QA dependency tracing

  const loadedDocs = loadAgentDocs();

  // Output result
  const result = {
    mainWorktreePath,
    branchName,
    ticketId: taskId,
    jiraTicketId: taskId, // deprecated: use ticketId instead
    reportFolder,
    changesHash,
    cache: cacheResult,
    impactedApps,
    affectedFiles,
    screenshotsFolder: path.join(reportFolder, 'screenshots'),
  };

  // Informational only — see findLegacyReportFolder. Omitted when there is
  // nothing stranded, so consumers can treat its presence as the signal.
  const legacyReportFolder = findLegacyReportFolder(mainWorktreePath, taskId, reportFolder);
  if (legacyReportFolder) result.legacyReportFolder = legacyReportFolder;

  // Always include all doc keys for stable JSON schema
  result.reviewDocs = loadedDocs.reviewDocs;
  result.qaDocs = loadedDocs.qaDocs;
  result.devDocs = loadedDocs.devDocs;
  result.e2eDocs = loadedDocs.e2eDocs;
  result.testDocs = loadedDocs.testDocs;
  result.storybookDocs = loadedDocs.storybookDocs;
  result.prDocs = loadedDocs.prDocs;

  // If not cached, setup the folder (purge is guarded by the cycle marker —
  // it only fires when a genuinely new cycle starts, see setupReportFolder)
  if (!cacheResult.cached) {
    result.reportsPurged = setupReportFolder(reportFolder, changesHash);
    result.foldersCreated = true;
  }

  console.log(JSON.stringify(result, null, 2));

  // Exit with code 0 if cached (skip checks), 1 if not cached (run checks)
  // Actually, let's not use exit codes - just output the JSON
  // The calling code will check result.cache.cached
}

// Allow importing individual functions for testing
if (require.main === module) {
  main();
} else {
  module.exports = {
    loadDocsFromPaths,
    DOCS_DENYLIST,
    resolveTicketId,
    deriveTaskId,
    setupReportFolder,
    shouldPurgeReports,
    checkReportsCache,
    findLegacyReportFolder,
  };
}
