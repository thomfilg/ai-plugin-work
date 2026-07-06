'use strict';

/**
 * tdd-phase-state/resume-completed.js
 *
 * GH-509 — machine-verified resume path for already-implemented work.
 *
 * When /work resumes a ticket whose implementation + tests were committed in
 * a prior interrupted session, the RED gate has no legitimate way to advance
 * (the test command exits 0 because the impl already exists). The
 * `record-resume-completed` subcommand records a complete synthetic cycle,
 * but ONLY when ALL four conditions are machine-verified — nothing here
 * trusts agent-supplied free text (including `--cmd`, which must match the
 * strategy-resolved command — see _assertCmdMatchesStrategy):
 *
 *   (a) no COMPLETED TDD evidence for the task (no cycle carries green or
 *       refactor evidence; a stale red-only record from an interrupted
 *       session is superseded and noted in the audit row meta — GH-509
 *       field case),
 *   (b) in-scope test files exist on disk and contain it()/test() blocks,
 *   (c) the test command passes (exit 0, no hang, real output),
 *   (d) `git log` shows at least one commit on the branch (vs the configured
 *       base, fallback origin/main) touching files in the task's scope.
 *
 * On success the cycle is stamped `resumedCompleted: true` with the verifying
 * command + HEAD sha, and an audit row `tdd-resume-completed` (HEAD sha +
 * matched commit shas) is appended to the ticket's actions log. Any failed
 * condition rejects with a message naming that condition.
 *
 * Self-service is safe per the repo's SHA-gated-enforcement precedent: every
 * condition is verified from git / the filesystem / on-disk tasks.md, and the
 * grant is audit-logged.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const {
  parseCmd,
  safeParseTask,
  runTestCommandWithOutput,
  formatTestTimeout,
  getCurrentCycleRecord,
  errorExit,
  successOut,
} = require('./io');
const { writeState, sanitizeId } = require('./state-path');
const { readActiveTaskBlock } = require('./active-task');
const { requireState, isEmptyTestOutput, rejectAllSkipped } = require('./record-helpers');
const { fileInTaskScope } = require('../../lib/task-scope');
const { resolveTasksBaseWithFallback } = require('../../lib/ticket-validation');

const REJECT_PREFIX = 'Rejected --resume-completed: ';

function _gitOut(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

/** Repo root from git (cwd fallback) — the recorder runs inside the worktree. */
function resolveRepoRoot() {
  return _gitOut(['rev-parse', '--show-toplevel'], process.cwd()) || process.cwd();
}

/**
 * First ref that resolves to a commit, trying the configured diff-base
 * candidates (BASE_BRANCH env / repo symbolic-ref via
 * config.getDiffBaseCandidates) then the origin/main + main fallbacks.
 * Returns null when nothing resolves (e.g. not a git repo).
 */
function resolveBaseRef(repoRoot) {
  let candidates = [];
  try {
    const config = require('../../lib/config');
    if (typeof config.getDiffBaseCandidates === 'function') {
      candidates = config.getDiffBaseCandidates({ cwd: repoRoot }) || [];
    }
  } catch {
    /* fall through to static fallbacks */
  }
  for (const ref of [...new Set([...candidates, 'origin/main', 'main'])]) {
    if (_gitOut(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoRoot)) return ref;
  }
  return null;
}

/** Parse `git log --pretty=format:@@%H --name-only` output → matched shas. */
function _matchCommitsFromLog(logStdout, scopeList) {
  const commits = [];
  let sha = null;
  let matched = false;
  for (const line of logStdout.split('\n')) {
    const t = line.trim();
    if (t.startsWith('@@')) {
      sha = t.slice(2);
      matched = false;
      continue;
    }
    if (!t || !sha || matched) continue;
    if (fileInTaskScope(t, scopeList)) {
      commits.push(sha);
      matched = true;
    }
  }
  return commits;
}

/**
 * Condition (d) probe — shared with task-next.js's block-message hint.
 * Returns `{ baseRef, headSha, commits }` where `commits` are the shas of
 * branch commits (vs base) touching files in the task's scope. Empty scope
 * or unresolvable base/HEAD yields `commits: []` (condition fails).
 */
function findScopeCommits(repoRoot, scope) {
  const scopeList = Array.isArray(scope) ? scope.filter((s) => typeof s === 'string' && s) : [];
  const baseRef = resolveBaseRef(repoRoot);
  const headSha = _gitOut(['rev-parse', 'HEAD'], repoRoot);
  if (!baseRef || !headSha || scopeList.length === 0) return { baseRef, headSha, commits: [] };
  const log = _gitOut(['log', '--pretty=format:@@%H', '--name-only', `${baseRef}..HEAD`], repoRoot);
  if (log === null) return { baseRef, headSha, commits: [] };
  return { baseRef, headSha, commits: _matchCommitsFromLog(log, scopeList) };
}

/**
 * Condition (a): reject only when a COMPLETED cycle exists (green or
 * refactor evidence). A stale red-only record from an interrupted session
 * proves nothing was completed — the GH-509 field case (GH-504) is exactly
 * a red cycle with testExitCode 1 and no green — so it is tolerated and
 * superseded (conditions b/c/d still machine-verify everything a normal
 * GREEN run would). Returns supersession info for the audit row meta, or
 * null when no stale red existed.
 */
function _assertNoCompletedEvidence(state) {
  const cycles = Array.isArray(state.cycles) ? state.cycles : [];
  const completed = cycles.find((c) => c && (c.green || c.refactor));
  if (completed) {
    errorExit(
      REJECT_PREFIX +
        `condition (a) failed — completed TDD evidence already recorded (cycle ${completed.cycle} ` +
        'has green/refactor evidence). The resume path is only for tasks with no ' +
        'completed cycles; continue the normal RED → GREEN → REFACTOR flow instead.'
    );
  }
  const staleRed = cycles.find((c) => c && c.red);
  if (!staleRed) return null;
  return {
    supersededStaleRed: true,
    staleRedCycle: staleRed.cycle,
    staleRedTimestamp: (staleRed.red && staleRed.red.timestamp) || null,
  };
}

/**
 * Resolve the EXPECTED test command for the task from its `### Test
 * Strategy` via the SHARED implement-gate resolver (validator-unification
 * rule: the same resolveTaskTestExecution the gate, the stop hook, and
 * task-next.js consume). Rejects when no runnable command resolves — the
 * resume path cannot verify anything without the planner-declared command.
 */
function _resolveExpectedCommand(ticketId, taskNum, repoRoot) {
  let command = null;
  try {
    const {
      resolveTaskTestExecution,
    } = require('../../work/lib/step-enrichments/implement-gate/test-command');
    const tasksDir = path.resolve(resolveTasksBaseWithFallback(), sanitizeId(ticketId));
    command = resolveTaskTestExecution(tasksDir, taskNum, repoRoot).command;
  } catch {
    command = null;
  }
  if (!command) {
    errorExit(
      REJECT_PREFIX +
        "could not resolve this task's `### Test Strategy` to a runnable command. " +
        'The recorder verifies --cmd against the strategy-resolved command and ' +
        'never trusts the caller; without a resolvable strategy there is nothing ' +
        'to verify against. Re-invoke via task-next.js (or fix the resolution ' +
        'environment: TASKS_BASE + worktree).'
    );
  }
  return command;
}

/**
 * The recorder verifies, never trusts: a caller-supplied `--cmd` that does
 * not match the strategy-resolved command (raw, or strict-mode-wrapped as
 * task-next.js forwards it) is rejected — otherwise an agent could verify a
 * vacuous command of its own instead of the task's declared one.
 */
function _assertCmdMatchesStrategy(cmd, expected) {
  const { wrapStrictMode } = require('../task-next.js');
  const supplied = String(cmd).trim();
  const ok = [expected, wrapStrictMode(expected)].some(
    (c) => typeof c === 'string' && c.trim() === supplied
  );
  if (!ok) {
    errorExit(
      REJECT_PREFIX +
        'the supplied --cmd does not match the strategy-resolved test command ' +
        `for this task. Expected (from tasks.md \`### Test Strategy\`): ${expected}\n` +
        'The recorder verifies the command against the planner-declared strategy ' +
        'and never trusts the caller. Re-invoke via ' +
        'task-next.js <TICKET> task<N> --resume-completed, which forwards the ' +
        'resolved command.'
    );
  }
}

/**
 * Condition (b): in-scope test files must exist on disk AND contain
 * it()/test() blocks. Reuses task-next.js's findTestFilesInScope +
 * countTestBlocksInFiles (lazy require — task-next.js also lazy-requires
 * this module for the hint path, so a top-level require would be circular).
 */
function _verifyScopeTestBlocks(repoRoot, scope) {
  const taskNext = require('../task-next.js');
  const testFiles = [...taskNext.findTestFilesInScope(repoRoot, scope)];
  const { totalBlocks, filesWithBlocks } = taskNext.countTestBlocksInFiles(testFiles);
  if (totalBlocks === 0) {
    errorExit(
      REJECT_PREFIX +
        'condition (b) failed — no in-scope *.test.* / *.spec.* file on disk ' +
        'contains it()/test() blocks. The resume path requires the pre-existing ' +
        "tests to be present under the task's Files in scope."
    );
  }
  return { testFileCount: filesWithBlocks, testBlockCount: totalBlocks };
}

/** Condition (d): at least one branch commit (vs base) touches scope files. */
function _verifyScopeCommits(repoRoot, scope) {
  const { baseRef, headSha, commits } = findScopeCommits(repoRoot, scope);
  if (!headSha) {
    errorExit(REJECT_PREFIX + 'condition (d) failed — could not resolve HEAD (not a git repo?).');
  }
  if (commits.length === 0) {
    errorExit(
      REJECT_PREFIX +
        `condition (d) failed — no commit on this branch (vs ${baseRef || 'unresolvable base'}) ` +
        "touches files in this task's scope. Uncommitted work does not qualify: the resume " +
        'path only accepts implementation already committed in a prior session.'
    );
  }
  return { baseRef, headSha, commits };
}

/** Condition (c): the command must run to completion, pass, and emit output. */
function _verifyPassingRun(cmd) {
  const { exitCode, stdout, stderr, timedOut, timeoutMs } = runTestCommandWithOutput(cmd);
  if (timedOut) {
    errorExit(
      REJECT_PREFIX +
        `condition (c) failed — test command timed out (${formatTestTimeout(timeoutMs)}) ` +
        'and was killed. A hang is not a passing run.'
    );
  }
  if (exitCode !== 0) {
    errorExit(
      REJECT_PREFIX +
        `condition (c) failed — test command exited ${exitCode}. The resume path requires ` +
        "the task's test command to PASS (exit 0) against the committed implementation."
    );
  }
  if (isEmptyTestOutput(stdout, stderr)) {
    errorExit(
      REJECT_PREFIX +
        'condition (c) failed — test command exited 0 with NO stdout/stderr output ' +
        '(empty-command trap: typically an unbound test-command env var expanding to ' +
        '`eval ""`). Real test runs always emit output.'
    );
  }
  rejectAllSkipped(stdout, stderr, 'RESUME-COMPLETED');
  return exitCode;
}

/** Best-effort `tdd-resume-completed` audit row; the state write is authoritative. */
function _appendResumeAudit(ticketId, taskNum, cycle, cmd, verified, superseded) {
  try {
    const { appendEnforcementAudit } = require('../../work/lib/work-actions');
    appendEnforcementAudit(ticketId, {
      origin: 'ai-subtask',
      task: taskNum || null,
      phase: 'red',
      action: 'tdd-resume-completed',
      allow: true,
      reason: 'machine-verified resume: implementation + tests pre-existing on branch',
      outputPath: null,
      meta: {
        cycle,
        testCommand: cmd,
        headSha: verified.headSha,
        baseRef: verified.baseRef,
        matchedCommits: verified.commits.slice(0, 20),
        testFileCount: verified.testFileCount,
        testBlockCount: verified.testBlockCount,
        // GH-509 — when a stale red-only record was superseded, say so
        // (supersededStaleRed / staleRedCycle / staleRedTimestamp).
        ...(superseded || {}),
      },
    });
  } catch {
    /* fail-open on audit write — the recorded cycle is the source of truth */
  }
}

/**
 * `record-resume-completed <TICKET_ID> --task <N> --cmd "<test command>"`
 *
 * Verifies conditions (a)–(d) above, then records a complete cycle
 * (red {skipped} + green + refactor, all stamped `resumedCompleted: true`)
 * and sets currentPhase to refactor so the derived phase is `done`.
 */
function cmdRecordResumeCompleted(ticketId, args) {
  if (!ticketId) errorExit('Missing ticket ID.');
  const cmd = parseCmd(args);
  if (!cmd) errorExit('Missing --cmd argument.');
  const taskNum = safeParseTask(args);
  if (!Number.isInteger(taskNum) || taskNum < 1) {
    errorExit(
      'record-resume-completed requires --task <N> so the recorder can verify ' +
        "the task's scope against on-disk tasks.md and git history."
    );
  }
  const opts = { taskNum };

  const state = requireState(ticketId, opts);
  const superseded = _assertNoCompletedEvidence(state); // (a)

  const repoRoot = resolveRepoRoot();
  // The recorder verifies --cmd against the strategy-resolved command
  // BEFORE running anything — never trusts the caller's command.
  _assertCmdMatchesStrategy(cmd, _resolveExpectedCommand(ticketId, taskNum, repoRoot));
  const { scope } = readActiveTaskBlock(ticketId, taskNum);
  const blocks = _verifyScopeTestBlocks(repoRoot, scope); // (b)
  const commits = _verifyScopeCommits(repoRoot, scope); // (d)
  const exitCode = _verifyPassingRun(cmd); // (c)

  const timestamp = new Date().toISOString();
  const record = getCurrentCycleRecord(state);
  record.resumedCompleted = true;
  record.red = {
    resumedCompleted: true,
    skipped: true,
    reason: 'resume-completed: implementation + tests pre-existing on branch (machine-verified)',
    testCommand: cmd,
    timestamp,
  };
  record.green = {
    resumedCompleted: true,
    testCommand: cmd,
    testExitCode: exitCode,
    headSha: commits.headSha,
    timestamp,
  };
  record.refactor = {
    resumedCompleted: true,
    testCommand: cmd,
    testExitCode: exitCode,
    headSha: commits.headSha,
    timestamp,
  };
  state.currentPhase = 'refactor';
  writeState(ticketId, state, opts);

  _appendResumeAudit(
    ticketId,
    taskNum,
    state.currentCycle,
    cmd,
    { ...commits, ...blocks },
    superseded
  );

  successOut({
    ok: true,
    resumedCompleted: true,
    phase: 'refactor',
    cycle: state.currentCycle,
    testExitCode: exitCode,
    headSha: commits.headSha,
    baseRef: commits.baseRef,
    matchedCommits: commits.commits,
  });
}

module.exports = {
  cmdRecordResumeCompleted,
  findScopeCommits,
  resolveBaseRef,
};
