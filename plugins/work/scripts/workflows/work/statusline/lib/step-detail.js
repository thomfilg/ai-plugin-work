'use strict';
/**
 * step-detail.js — per-step "sub-bar" renderers for the /work status bar.
 *
 * Each step gets its own tiny renderer keyed in DETAIL_RENDERERS, so adding a
 * richer bar for a new step is a one-line registry entry rather than a branch
 * in the main renderer. A renderer takes the parsed `.work-state.json` and
 * returns a short detail string (or '' for no detail).
 */

const MAX_TITLE = 44;

// Trim a task title so the bar stays one line in a narrow terminal.
function short(title) {
  const t = String(title || '').trim();
  if (!t) return '';
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1)}…` : t;
}

// The task the implement step is on: prefer the `in_progress` task, else the
// `currentTaskIndex` cursor. Renders `task <i>/<n>: <title>`.
function implementDetail(state) {
  const meta = state.tasksMeta || {};
  const tasks = Array.isArray(meta.tasks) ? meta.tasks : [];
  if (!tasks.length) return '';
  const total = meta.totalTasks || tasks.length;
  let idx = tasks.findIndex((t) => t && t.status === 'in_progress');
  if (idx === -1) {
    idx = Number.isInteger(meta.currentTaskIndex) ? meta.currentTaskIndex - 1 : tasks.length - 1;
  }
  const task = tasks[idx];
  if (!task) return '';
  const title = short(task.title);
  return `task ${idx + 1}/${total}${title ? `: ${title}` : ''}`;
}

// What the check step is doing: the check→implement retry count when the run
// has bounced back, else a plain "running checks".
function checkDetail(state) {
  const progress = state.checkProgress || {};
  const retries = Number.isInteger(progress.implement) ? progress.implement : 0;
  return retries > 0 ? `retry ${retries} (check→implement)` : 'running checks';
}

// The per-task review step: the highest fix-round across tasks, if any.
function taskReviewDetail(state) {
  const tasks = (state.tasksMeta && state.tasksMeta.tasks) || [];
  const rounds = tasks
    .map((t) => (t && Number.isInteger(t.taskReviewFixRounds) ? t.taskReviewFixRounds : 0))
    .reduce((max, n) => Math.max(max, n), 0);
  return rounds > 0 ? `fix round ${rounds}` : 'reviewing tasks';
}

const DETAIL_RENDERERS = Object.freeze({
  implement: implementDetail,
  check: checkDetail,
  task_review: taskReviewDetail,
});

/**
 * Detail string for a step, or '' when the step has no dedicated sub-bar.
 * @param {string} step step id
 * @param {object} state parsed `.work-state.json`
 * @returns {string}
 */
function detailFor(step, state) {
  const renderer = DETAIL_RENDERERS[step];
  if (!renderer) return '';
  try {
    return renderer(state) || '';
  } catch {
    return '';
  }
}

module.exports = { detailFor, DETAIL_RENDERERS };
