/**
 * Step: task-review (GH-211)
 *
 * Per-task review gate that blocks the check step until an intermediate
 * task's code has been reviewed. Runs between `commit` and `check` in the
 * pipeline and uses task metadata set by the upstream `implement` step
 * (via `ctx._taskData`, `ctx._currentTaskIdx`).
 *
 * Decision matrix:
 *   1. `TASK_REVIEW_ENABLED=0`               -> DEFER "Task review disabled"
 *   2. No tasks (no taskData or no tasksMeta) -> DEFER "No tasks"
 *   3. Final task (current == last)           -> DEFER "Final task -- /check handles review"
 *   4. Fix rounds exhausted (>= max)          -> RUN  AskUserQuestion escalation
 *   5. Intermediate task needing review       -> RUN  parallel /tests-review + /code-review
 *      (unless commit evidence is missing — GH-693 — then RUN AskUserQuestion
 *      escalation instead of scheduling a vacuous review)
 */

'use strict';

const path = require('path');
const { appendAction } = require(path.join(__dirname, '..', 'lib', 'work-actions'));
const { computeTaskDiff } = require('../gates/task-review-gate');
const { taskSegment } = require('../../lib/allocate-output-folder');
const { T, renderQuestionText, getRuntime } = require('../../lib/instruction-vocab');

/**
 * Decisions 1-3: DEFER reason, or null when an intermediate task needs review.
 */
function deferReason(s, ctx) {
  // Decision 1: disabled via env
  if (process.env.TASK_REVIEW_ENABLED === '0') {
    return 'Task review disabled (TASK_REVIEW_ENABLED=0)';
  }
  // Decision 2: no tasks (gathered from implement step and state)
  if (!s?.hasTasks || !ctx._taskData || !s?.workState?.tasksMeta) {
    return 'No tasks';
  }
  // Decision 3: final task -- /check handles the full review
  const currentIdx = ctx._currentTaskIdx ?? 0;
  if (currentIdx >= ctx._taskData.length - 1) {
    return 'Final task -- /check handles review';
  }
  return null;
}

function resolveMaxFixRounds() {
  const parsed = parseInt(process.env.TASK_REVIEW_MAX_FIXES, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
}

/**
 * Decision 4: fix rounds exhausted -- escalate to user. The question
 * renderer keeps claude byte-identical and swaps the codex vocabulary
 * (request_user_input prose / parked-gate notice per mode, C3).
 */
function addEscalation(add, ctx, { currentIdx, totalTasks, fixRounds, maxFixRounds }) {
  const { STEPS } = ctx;
  const rt = getRuntime();
  add(
    STEPS.task_review,
    'RUN',
    T('tool.question', {}, rt.name),
    `Task ${currentIdx + 1}/${totalTasks} fix rounds exhausted (${fixRounds}/${maxFixRounds}) -- escalating to user`,
    {
      agentType: 'general-purpose',
      agentPrompt: renderQuestionText(
        `Task ${currentIdx + 1} has exhausted ${fixRounds}/${maxFixRounds} fix rounds. Use AskUserQuestion to ask the user whether to continue fixing, skip the review, or abort.`,
        rt
      ),
    }
  );
  appendAction(ctx.ticket, {
    step: STEPS.task_review,
    what: `task ${currentIdx + 1}/${totalTasks} fix rounds exhausted (${fixRounds}/${maxFixRounds}) -- escalating`,
  });
}

/**
 * GH-693: commit evidence missing — computeTaskDiff returned { blocked }.
 * Never schedule a vacuous review; escalate to the user via the same
 * AskUserQuestion shape as the fix-rounds escalation, and audit the block.
 */
function addBlockedEscalation(add, ctx, { currentIdx, totalTasks, reason }) {
  const { STEPS } = ctx;
  const rt = getRuntime();
  add(
    STEPS.task_review,
    'RUN',
    T('tool.question', {}, rt.name),
    `Task ${currentIdx + 1}/${totalTasks} blocked: commit evidence missing (${reason}) -- escalating to user`,
    {
      agentType: 'general-purpose',
      agentPrompt: renderQuestionText(
        `Task ${currentIdx + 1} cannot be reviewed: ${reason}. Use AskUserQuestion to ask the user whether to run the commit step now, fetch the base ref, or abort.`,
        rt
      ),
    }
  );
  appendAction(ctx.ticket, {
    step: STEPS.task_review,
    what: `task ${currentIdx + 1}/${totalTasks} review blocked: commit evidence missing (${reason}) -- escalating`,
  });
}

/**
 * Compute the task-scoped diff range for the review. GH-693 blocked results
 * ({ blocked, reason }) pass through; exceptions ALSO fail closed as a
 * blocked result (PR #716) — computeTaskDiff catches git/fs failures
 * internally, so a throw means the range is unverifiable and must route to
 * the escalation, never to a scheduled review with no valid diff range.
 */
function computeDiffRange(reviewTasksDir, ticket) {
  try {
    return computeTaskDiff(reviewTasksDir, ticket);
  } catch (e) {
    const detail = e && typeof e.message === 'string' ? e.message : String(e);
    return {
      blocked: true,
      reason: `commit evidence check failed while computing task diff: ${detail}`,
    };
  }
}

/**
 * Decision 5: intermediate task -- run parallel tests-review + code-review.
 */
function addReviewRun(add, ctx, { currentIdx, totalTasks, currentTask }) {
  const { STEPS } = ctx;
  const taskTitle = currentTask?.title || 'unknown';
  // Override tasksDir to per-task subfolder when task context is available.
  // ctx._currentTaskIdx is set by the implement step; when present (not undefined/null),
  // use taskSegment() to construct the per-task path for artifact resolution.
  const reviewTasksDir =
    ctx._currentTaskIdx != null
      ? path.join(ctx.tasksDir, taskSegment(currentIdx + 1))
      : ctx.tasksDir;
  // Compute task-scoped diff range via computeTaskDiff (reads .last-commit-sha,
  // validates, falls back to the merge-base on missing/invalid SHA). The range
  // is passed to the orchestrator in plan-entry metadata so /tests-review and
  // /code-review receive the task-specific diff, not the full branch diff.
  const diffRange = computeDiffRange(reviewTasksDir, ctx.ticket);
  // GH-693: zero commits ahead of base (or git failure) — the diff range is
  // vacuous. Escalate instead of scheduling a review that reviews nothing.
  if (diffRange && diffRange.blocked) {
    addBlockedEscalation(add, ctx, { currentIdx, totalTasks, reason: diffRange.reason });
    return;
  }
  add(
    STEPS.task_review,
    'RUN',
    'Skill(tests-review) + Skill(code-review)',
    `Task ${currentIdx + 1}/${totalTasks}: review "${taskTitle}" before advancing`,
    {
      agentType: 'skill',
      agentPrompt: `Run /tests-review and /code-review in parallel for task ${currentIdx + 1}/${totalTasks} ("${taskTitle}"). Scope both reviews to the task diff range${diffRange ? ` (base=${diffRange.base}, head=${diffRange.head})` : ' (computed from .last-commit-sha)'}. Set REPORT_FOLDER=${reviewTasksDir} for both skills. Aggregate results and fail the gate if either review fails.`,
      diffRange,
      reportFolder: reviewTasksDir,
    }
  );
  appendAction(ctx.ticket, {
    step: STEPS.task_review,
    what: `task ${currentIdx + 1}/${totalTasks} review scheduled for "${taskTitle}"`,
  });
}

/**
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function taskReviewStep(add, s, ctx) {
  const { STEPS } = ctx;

  const defer = deferReason(s, ctx);
  if (defer) {
    add(STEPS.task_review, 'DEFER', null, defer);
    return;
  }

  const taskData = ctx._taskData;
  const currentIdx = ctx._currentTaskIdx ?? 0;
  const totalTasks = taskData.length;

  // Read fix-round state from tasksMeta.
  // Note: taskReviewFixRounds is incremented by the orchestrator when it loops back
  // to implement after a failed review (see work-state.js incrementTaskReviewFixRounds).
  // This step only reads the counter to decide whether to escalate.
  const currentTaskMeta = s.workState.tasksMeta.tasks?.[currentIdx];
  const fixRounds = currentTaskMeta?.taskReviewFixRounds || 0;
  const maxFixRounds = resolveMaxFixRounds();

  if (fixRounds >= maxFixRounds) {
    addEscalation(add, ctx, { currentIdx, totalTasks, fixRounds, maxFixRounds });
    return;
  }

  addReviewRun(add, ctx, { currentIdx, totalTasks, currentTask: taskData[currentIdx] });
};

module.exports.taskReviewStep = module.exports;
