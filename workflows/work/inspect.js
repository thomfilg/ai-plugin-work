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
  const {
    tp,
    run,
    fileExists,
    readFile,
    listFiles,
    loadWorkState,
    getCurrentStep,
    REQUIRED_REPORTS,
    WORKTREES_BASE,
    TASKS_BASE,
    MAIN_WORKTREE_FOLDER,
  } = deps;

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

  // Git
  if (s.worktreeExists) {
    const c = s.worktreeDir;
    s.branch = run(`git -C "${c}" branch --show-current`);
    s.headSha = run(`git -C "${c}" rev-parse HEAD`);
    let baseBranch = 'origin/main';
    try {
      baseBranch = require(path.join(__dirname, '..', 'lib', 'config')).getBaseBranch({ cwd: c });
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
  } else {
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
  }

  // PR
  s.pr = null;
  if (s.worktreeExists && s.branch) {
    const j = run(`gh pr view "${s.branch}" --json number,state,isDraft,url 2>/dev/null`, {
      cwd: s.worktreeDir,
    });
    if (j) {
      try {
        s.pr = JSON.parse(j);
      } catch {}
    }
  }

  // Reports
  s.reports = {};
  s.allReportsPass = true;
  s.missingReports = [];
  s.failedReports = [];
  for (const { file, passPattern } of REQUIRED_REPORTS) {
    const fp = path.join(s.tasksDir, file);
    if (!fileExists(fp)) {
      s.reports[file] = { exists: false, passes: false };
      s.allReportsPass = false;
      s.missingReports.push(file);
    } else {
      const passes = passPattern.test(readFile(fp));
      s.reports[file] = { exists: true, passes };
      if (!passes) {
        s.allReportsPass = false;
        s.failedReports.push(file);
      }
    }
  }
  for (const qp of listFiles(s.tasksDir, /^qa-.*\.check\.md$/)) {
    const name = path.basename(qp);
    const passes = /Status:\s*APPROVED/i.test(readFile(qp));
    s.reports[name] = { exists: true, passes };
    s.qaReportCount = (s.qaReportCount || 0) + 1;
    if (!passes) {
      s.allReportsPass = false;
      s.failedReports.push(name);
    }
  }

  // Per-task reports (GH-259 Task 7.1)
  // When tasks.md exists, scan taskN/ subdirectories for check reports and TDD evidence.
  // Uses deps.listFiles/fileExists/readFile for most I/O; fs.statSync for directory detection
  // (no deps.isDirectory exists — acceptable since listFiles already filters by regex).
  if (fileExists(path.join(s.tasksDir, 'tasks.md'))) {
    const { validateTddEvidence } = require(path.join(__dirname, 'tdd-enforcement'));
    s.perTaskReports = {};
    const taskDirNames = listFiles(s.tasksDir, /^task\d+$/)
      .filter((fp) => { try { return fs.statSync(fp).isDirectory(); } catch { return false; } })
      .map((fp) => path.basename(fp));
    for (const taskDirName of taskDirNames) {
      const taskDir = path.join(s.tasksDir, taskDirName);
      const taskReport = { tddPhase: null, checkReports: [] };

      // Read tdd-phase.json if present — uses shared validateTddEvidence for consistency
      const tddPath = path.join(taskDir, 'tdd-phase.json');
      if (fileExists(tddPath)) {
        try {
          const tddData = JSON.parse(readFile(tddPath));
          const validation = validateTddEvidence(tddData);
          const hasException =
            (typeof tddData.exception === 'string' && tddData.exception.trim() !== '') ||
            (typeof tddData.exception === 'object' && tddData.exception !== null && typeof tddData.exception.category === 'string');
          taskReport.tddPhase = {
            exists: true,
            valid: validation.valid,
            exception: hasException,
            cycleCount: Array.isArray(tddData.cycles) ? tddData.cycles.length : 0,
          };
        } catch {
          taskReport.tddPhase = { exists: true, valid: false, parseError: true };
        }
      }

      // Scan for *.check.md files in the task dir
      taskReport.checkReports = listFiles(taskDir, /\.check\.md$/).map((fp) => path.basename(fp));

      s.perTaskReports[taskDirName] = taskReport;
    }
  }

  // SHA tracking
  s.prUpdateSha = fileExists(path.join(s.tasksDir, '.pr-update-sha'))
    ? readFile(path.join(s.tasksDir, '.pr-update-sha')).trim()
    : null;
  s.postPrUpdateSha = fileExists(path.join(s.tasksDir, '.post-pr-update-sha'))
    ? readFile(path.join(s.tasksDir, '.post-pr-update-sha')).trim()
    : null;
  s.prEverUpdated = s.prUpdateSha !== null;
  s.prShaMatch = !!(s.headSha && s.prUpdateSha && s.headSha === s.prUpdateSha.split('|')[0]);

  // Content SHA
  if (s.tasksDirExists) {
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

  s.hasBrief = fileExists(path.join(s.tasksDir, 'brief.md'));
  s.hasSpec = fileExists(path.join(s.tasksDir, 'spec.md'));
  s.hasTasks = fileExists(path.join(s.tasksDir, 'tasks.md'));

  // Dev session
  s.hasDevSession = run(`tmux has-session -t "${ticket}-dev" 2>/dev/null && echo yes`) === 'yes';

  return s;
}

module.exports = { inspect };
