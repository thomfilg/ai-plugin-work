/**
 * inspect.js
 *
 * State inspection: gathers real-world state (git, files, worktrees, reports,
 * tmux sessions, PR info) for the orchestrator's plan generation.
 *
 * Pure function: takes (ticket, providerConfig, suffix, deps) and returns
 * a state object. All side-effecting operations go through the `deps`
 * object for testability.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { parseReportStatus } = require(
  path.join(__dirname, '..', '..', 'lib', 'parse-report-status')
);
const { phaseLedgerBlocked } = require(path.join(__dirname, '..', 'lib', 'phase-ledger'));

// Report-type mapping for the parse-report-status fallback (echo-5219: reviewer
// agents emit prose verdicts like "## Overall Assessment: ✅ Well-Implemented"
// or "### Final Status:\n[COMPLETE]" that the strict passPattern regexes miss;
// without the fallback the check step re-dispatches check in a loop).
const REPORT_TYPE_BY_FILE = Object.create(null);
REPORT_TYPE_BY_FILE['tests.check.md'] = 'tests';
REPORT_TYPE_BY_FILE['code-review.check.md'] = 'codeReview';
REPORT_TYPE_BY_FILE['completion.check.md'] = 'completion';

/** Git facts from the ticket worktree (or the no-worktree defaults). */
function collectGitState(s, deps, ticket) {
  const { run } = deps;
  if (!s.worktreeExists) {
    Object.assign(s, {
      branch: null,
      headSha: null,
      hasDiffVsMain: false,
      diffSummary: 'no worktree',
      hasCommitWithTicket: false,
      hasUncommitted: false,
      uncommittedCount: 0,
      hasUnpushed: false,
      lastCommitMsg: '',
    });
    return;
  }
  const c = s.worktreeDir;
  s.branch = run(`git -C "${c}" branch --show-current`);
  s.headSha = run(`git -C "${c}" rev-parse HEAD`);
  let baseBranch = 'origin/main';
  try {
    baseBranch = require(path.join(__dirname, '..', '..', 'lib', 'config')).getBaseBranch({
      cwd: c,
    });
  } catch {
    /* */
  }
  const diff = run(`git -C "${c}" diff --shortstat ${baseBranch} -- . 2>/dev/null`);
  s.hasDiffVsMain = diff !== '';
  s.diffSummary = diff || 'no changes';
  s.lastCommitMsg = run(`git -C "${c}" log -1 --format="%s" 2>/dev/null`);
  s.hasCommitWithTicket = s.lastCommitMsg.includes(ticket);
  s.uncommittedFiles = run(`git -C "${c}" status --porcelain 2>/dev/null`);
  s.hasUncommitted = s.uncommittedFiles !== '';
  s.uncommittedCount = s.hasUncommitted ? s.uncommittedFiles.split('\n').length : 0;
  s.hasUnpushed = s.branch
    ? run(`git -C "${c}" log origin/${s.branch}..HEAD --oneline 2>/dev/null`) !== ''
    : false;
}

/** Open-PR info for the worktree branch (null when absent/unparseable). */
function collectPrState(s, deps) {
  s.pr = null;
  if (!s.worktreeExists || !s.branch) return;
  const j = deps.run(`gh pr view "${s.branch}" --json number,state,isDraft,url 2>/dev/null`, {
    cwd: s.worktreeDir,
  });
  if (j) {
    try {
      s.pr = JSON.parse(j);
    } catch {}
  }
}

/**
 * Required check reports. Fast path: strict passPattern. Fallback: the shared
 * status parser, which understands the canonical **Status:** line and the
 * reviewer agents' real-world prose verdicts (echo-5219 issue 2).
 */
function collectRequiredReports(s, deps) {
  const { fileExists, readFile, REQUIRED_REPORTS } = deps;
  for (const { file, passPattern, type } of REQUIRED_REPORTS) {
    const fp = path.join(s.tasksDir, file);
    if (!fileExists(fp)) {
      s.reports[file] = { exists: false, passes: false };
      s.allReportsPass = false;
      s.missingReports.push(file);
      continue;
    }
    const content = readFile(fp);
    const reportType = type || REPORT_TYPE_BY_FILE[file];
    const passes =
      passPattern.test(content) ||
      (reportType ? parseReportStatus(content, reportType).status === 'APPROVED' : false);
    s.reports[file] = { exists: true, passes };
    if (!passes) {
      s.allReportsPass = false;
      s.failedReports.push(file);
    }
  }
}

/** QA reports (qa-*.check.md) — APPROVED or NOT_APPLICABLE both pass. */
function collectQaReports(s, deps) {
  const { listFiles, readFile } = deps;
  for (const qp of listFiles(s.tasksDir, /^qa-.*\.check\.md$/)) {
    const name = path.basename(qp);
    const qaContent = readFile(qp);
    const qaStatus = parseReportStatus(qaContent, 'qa').status;
    const passes =
      /Status:\s*APPROVED/i.test(qaContent) ||
      qaStatus === 'APPROVED' ||
      qaStatus === 'NOT_APPLICABLE';
    s.reports[name] = { exists: true, passes };
    s.qaReportCount = (s.qaReportCount || 0) + 1;
    if (!passes) {
      s.allReportsPass = false;
      s.failedReports.push(name);
    }
  }
}

/** tdd-phase.json summary for one task dir — uses shared validateTddEvidence. */
function readTaskTddPhase(deps, taskDir, validateTddEvidence) {
  const tddPath = path.join(taskDir, 'tdd-phase.json');
  if (!deps.fileExists(tddPath)) return null;
  try {
    const tddData = JSON.parse(deps.readFile(tddPath));
    const validation = validateTddEvidence(tddData);
    const hasException =
      (typeof tddData.exception === 'string' && tddData.exception.trim() !== '') ||
      (typeof tddData.exception === 'object' &&
        tddData.exception !== null &&
        typeof tddData.exception.category === 'string');
    return {
      exists: true,
      valid: validation.valid,
      exception: hasException,
      cycleCount: Array.isArray(tddData.cycles) ? tddData.cycles.length : 0,
    };
  } catch {
    return { exists: true, valid: false, parseError: true };
  }
}

/**
 * Per-task reports (GH-259 Task 7.1).
 * When tasks.md exists, scan taskN/ subdirectories for check reports and TDD evidence.
 * Uses deps.listFiles/fileExists/readFile for most I/O; fs.statSync for directory detection
 * (no deps.isDirectory exists — acceptable since listFiles already filters by regex).
 */
function collectPerTaskReports(s, deps) {
  const { fileExists, listFiles } = deps;
  if (!fileExists(path.join(s.tasksDir, 'tasks.md'))) return;
  const { validateTddEvidence } = require(path.join(__dirname, '..', 'lib', 'tdd-enforcement'));
  s.perTaskReports = {};
  const taskDirNames = listFiles(s.tasksDir, /^task\d+$/)
    .filter((fp) => {
      try {
        return fs.statSync(fp).isDirectory();
      } catch {
        return false;
      }
    })
    .map((fp) => path.basename(fp));
  for (const taskDirName of taskDirNames) {
    const taskDir = path.join(s.tasksDir, taskDirName);
    s.perTaskReports[taskDirName] = {
      tddPhase: readTaskTddPhase(deps, taskDir, validateTddEvidence),
      // Scan for *.check.md files in the task dir
      checkReports: listFiles(taskDir, /\.check\.md$/).map((fp) => path.basename(fp)),
    };
  }
}

/** PR-update SHA tracking files. */
function collectShaTracking(s, deps) {
  const { fileExists, readFile } = deps;
  s.prUpdateSha = fileExists(path.join(s.tasksDir, '.pr-update-sha'))
    ? readFile(path.join(s.tasksDir, '.pr-update-sha')).trim()
    : null;
  s.postPrUpdateSha = fileExists(path.join(s.tasksDir, '.post-pr-update-sha'))
    ? readFile(path.join(s.tasksDir, '.post-pr-update-sha')).trim()
    : null;
  s.prEverUpdated = s.prUpdateSha !== null;
  s.prShaMatch = !!(s.headSha && s.prUpdateSha && s.headSha === s.prUpdateSha.split('|')[0]);
}

/** Content SHA over QA reports + screenshots (post-PR update detection). */
function collectContentSha(s, deps) {
  const { run, fileExists, readFile, listFiles } = deps;
  if (!s.tasksDirExists) return;
  const qaContent = listFiles(s.tasksDir, /^qa-.*\.check\.md$/)
    .map((f) => readFile(f))
    .join('');
  const ssDir = path.join(s.tasksDir, 'screenshots');
  let ssContent = '';
  if (fileExists(ssDir)) {
    const files = run(`find "${ssDir}" -type f 2>/dev/null | sort`);
    if (files)
      ssContent = files
        .split('\n')
        .map((f) => {
          try {
            return fs.readFileSync(f);
          } catch {
            return '';
          }
        })
        .join('');
  }
  s.contentSha =
    qaContent || ssContent
      ? crypto
          .createHash('sha256')
          .update(qaContent + ssContent)
          .digest('hex')
      : null;
  s.postPrShaMatch = !!(s.contentSha && s.contentSha === s.postPrUpdateSha);
}

/**
 * @param {string} ticket
 * @param {object} providerConfig
 * @param {string|null} suffix
 * @param {object} deps - { tp, run, fileExists, readFile, listFiles,
 *   loadWorkState, getCurrentStep, REQUIRED_REPORTS,
 *   WORKTREES_BASE, TASKS_BASE, MAIN_WORKTREE_FOLDER }
 * @returns {object} state
 */
function inspect(ticket, providerConfig, suffix, deps) {
  const { tp, run, fileExists, loadWorkState, getCurrentStep } = deps;
  const { WORKTREES_BASE, TASKS_BASE, MAIN_WORKTREE_FOLDER } = deps;

  const s = {};
  const safeBase = tp.sanitizeTicketIdForPath(ticket, providerConfig);
  const safeName = suffix ? safeBase + '/' + suffix : safeBase;

  s.worktreeDir = path.join(WORKTREES_BASE, `${MAIN_WORKTREE_FOLDER}-${safeBase}`);
  s.tasksDir = path.join(TASKS_BASE, safeName);
  s.worktreeExists = fileExists(s.worktreeDir);
  s.tasksDirExists = fileExists(s.tasksDir);

  s.workState = loadWorkState(safeName);
  s.hasStateFile = s.workState !== null;
  s.currentStep = getCurrentStep(s.workState);
  s.stepIs = (step) => s.workState?.stepStatus?.[step] || 'unknown';

  collectGitState(s, deps, ticket);
  collectPrState(s, deps);

  s.reports = {};
  s.allReportsPass = true;
  s.missingReports = [];
  s.failedReports = [];
  collectRequiredReports(s, deps);
  collectQaReports(s, deps);
  collectPerTaskReports(s, deps);
  collectShaTracking(s, deps);
  collectContentSha(s, deps);

  s.hasBrief = fileExists(path.join(s.tasksDir, 'brief.md'));
  s.hasSpec = fileExists(path.join(s.tasksDir, 'spec.md'));
  s.hasGherkin = fileExists(path.join(s.tasksDir, 'gherkin.feature'));
  s.hasTasks = fileExists(path.join(s.tasksDir, 'tasks.md'));

  // GH-696: inner phase-ledger resume signals for the plan matrix — a step
  // whose artifact exists but whose *-phase.json is non-terminal needs its
  // writer agent re-dispatched (the runner resumes from the recorded phase).
  const briefLedger = phaseLedgerBlocked(s.tasksDir, 'brief');
  const specLedger = phaseLedgerBlocked(s.tasksDir, 'spec');
  const tasksLedger = phaseLedgerBlocked(s.tasksDir, 'tasks');
  s.briefPhaseMidFlight = briefLedger.blocked;
  s.briefPhase = briefLedger.currentPhase;
  s.specPhaseMidFlight = specLedger.blocked;
  s.specPhase = specLedger.currentPhase;
  s.tasksPhaseMidFlight = tasksLedger.blocked;
  s.tasksPhase = tasksLedger.currentPhase;

  // Dev session
  s.hasDevSession = run(`tmux has-session -t "${ticket}-dev" 2>/dev/null && echo yes`) === 'yes';

  return s;
}

module.exports = { inspect };
