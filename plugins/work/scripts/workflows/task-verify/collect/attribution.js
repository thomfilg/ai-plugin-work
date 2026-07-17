'use strict';

/**
 * task-verify/collect/attribution.js — commit-attribution collector (GH-769).
 *
 * Parses `Work-Task` commit trailers, partitions a base..head range into
 * own / foreign / unattributed commits for a given task number, and computes
 * the attributed diff union for the own-commit set.
 *
 * Fail-open contract: `resolveAttribution` NEVER throws. Any git failure
 * degrades to `{ supported: false, mode: 'none', ... }` so a boundary is
 * never hard-blocked because of attribution (spec R3). All git reads go
 * through the shared `git-facts.js git()` wrapper (array args, timeout
 * bounded — no shell interpolation of trailer values or refs, spec R2).
 */

const { git } = require('./git-facts');

/** Trailer key every wave commit carries: `Work-Task: <N>`. */
const WORK_TASK_TRAILER = 'Work-Task';

// Spec R2 hardening: only `4`, `task4`, `task 4` (any case, <= 4 digits).
const WORK_TASK_VALUE_RE = /^(?:task\s*)?(\d{1,4})$/i;

// git log field separators: %x1f between sha and trailer values, %x2c
// between multiple trailer values on one commit.
const LOG_FORMAT = `%H%x1f%(trailers:key=${WORK_TASK_TRAILER},valueonly,separator=%x2c)`;

/**
 * Parse a raw `Work-Task` trailer value into an integer task id.
 * Anything outside `/^(?:task\s*)?(\d{1,4})$/i` is unattributed (null) —
 * hostile values never crash parsing and never reach downstream as raw text.
 *
 * @param {unknown} raw trailer value as written in the commit
 * @returns {number|null} re-serialized integer task id, or null
 */
function parseWorkTaskValue(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(WORK_TASK_VALUE_RE);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * First valid task id among a commit's (possibly multiple) trailer values.
 *
 * @param {string} joined comma-joined `Work-Task` trailer values (may be '')
 * @returns {number|null}
 */
function firstValidTaskId(joined) {
  if (!joined) return null;
  for (const value of joined.split(',')) {
    const id = parseWorkTaskValue(value);
    if (id !== null) return id;
  }
  return null;
}

/**
 * List commits in `baseRef..headRef` (oldest first) with their attributed
 * task id. Throws on git failure — callers that must not throw go through
 * `resolveAttribution`.
 *
 * @param {string} repoDir
 * @param {string} baseRef
 * @param {string} headRef
 * @returns {Array<{ sha: string, taskId: number|null }>}
 */
function commitsInRange(repoDir, baseRef, headRef) {
  const out = git(repoDir, [
    'log',
    '--reverse',
    `--format=${LOG_FORMAT}`,
    `${baseRef}..${headRef}`,
  ]);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, trailers = ''] = line.split('\x1f');
      return { sha, taskId: firstValidTaskId(trailers) };
    });
}

/**
 * Partition commits into own / foreign / unattributed for `taskNum`.
 * Own shas keep range order; foreign task ids are deduped, numerically
 * sorted, and re-serialized as decimal strings (spec R2).
 *
 * @param {Array<{ sha: string, taskId: number|null }>} commits
 * @param {number} taskNum
 * @returns {{ own: string[], foreignTasks: string[], unattributedCount: number }}
 */
function partitionForTask(commits, taskNum) {
  const own = [];
  const foreign = new Set();
  let unattributedCount = 0;
  for (const { sha, taskId } of commits) {
    if (taskId === null) unattributedCount += 1;
    else if (taskId === taskNum) own.push(sha);
    else foreign.add(taskId);
  }
  const foreignTasks = [...foreign].sort((a, b) => a - b).map((id) => String(id));
  return { own, foreignTasks, unattributedCount };
}

/**
 * Sorted, deduped union of files touched by `shas`. Merge commits contribute
 * nothing (`git diff-tree --no-commit-id --name-only -r` on a merge without
 * `-m` prints no paths). Throws on git failure — see `resolveAttribution`
 * for the fail-open wrapper.
 *
 * @param {string} repoDir
 * @param {string[]} shas
 * @returns {string[]}
 */
function changedFilesForCommits(repoDir, shas) {
  const files = new Set();
  for (const sha of shas) {
    const out = git(repoDir, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]);
    if (!out) continue;
    for (const f of out.split('\n')) {
      if (f) files.add(f);
    }
  }
  return [...files].sort();
}

/** The fail-open degraded result: attribution unavailable, never blocking. */
function unsupportedResult() {
  return {
    supported: false,
    mode: 'none',
    taskId: null,
    foreignTasks: [],
    unattributedCount: 0,
    attributedFiles: [],
  };
}

/**
 * Resolve attribution for a task over `baseRef..headRef`.
 *
 * - Trailer-attributed range → `{ supported: true, mode: 'trailer', taskId,
 *   foreignTasks, unattributedCount, attributedFiles }` where
 *   `attributedFiles` is the diff union of THIS task's commits only.
 * - Range with no valid trailer at all → `mode: 'none'` (legacy diff keeps
 *   authority downstream, spec R9).
 * - ANY git failure (bogus repoDir, unresolvable ref, timeout) → the
 *   `{ supported: false, mode: 'none', ... }` degraded shape. Never throws.
 *
 * @param {{ repoDir: string, baseRef: string, headRef: string, taskNum: number }} input
 * @returns {{ supported: boolean, mode: 'trailer'|'none', taskId: number|null,
 *   foreignTasks: string[], unattributedCount: number, attributedFiles: string[] }}
 */
function resolveAttribution({ repoDir, baseRef, headRef, taskNum }) {
  try {
    // Coerce to an integer so callers may pass a numeric string (task ids
    // arrive as strings from the task parser); partitioning compares ints.
    const taskId = Number.parseInt(taskNum, 10);
    const commits = commitsInRange(repoDir, baseRef, headRef);
    const { own, foreignTasks, unattributedCount } = partitionForTask(commits, taskId);
    const anyAttributed = commits.some((c) => c.taskId !== null);
    if (!anyAttributed) {
      return {
        supported: true,
        mode: 'none',
        taskId: null,
        foreignTasks: [],
        unattributedCount,
        attributedFiles: [],
      };
    }
    return {
      supported: true,
      mode: 'trailer',
      taskId,
      foreignTasks,
      unattributedCount,
      attributedFiles: changedFilesForCommits(repoDir, own),
    };
  } catch {
    return unsupportedResult();
  }
}

module.exports = {
  WORK_TASK_TRAILER,
  parseWorkTaskValue,
  commitsInRange,
  partitionForTask,
  changedFilesForCommits,
  resolveAttribution,
};
