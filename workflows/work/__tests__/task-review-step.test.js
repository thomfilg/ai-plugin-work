/**
 * Unit tests for the task-review step module (GH-211, Task 5).
 *
 * Covers the five decision paths:
 *   1. DEFER when TASK_REVIEW_ENABLED=0
 *   2. DEFER when no tasks (no hasTasks or no taskData)
 *   3. DEFER when final task (current task is last)
 *   4. RUN for intermediate task needing review
 *   5. RUN with AskUserQuestion escalation when max fix rounds exhausted
 *
 * Also verifies registration in STEP_PIPELINE between commitStep and checkStep.
 *
 * Run: node --test workflows/work/__tests__/task-review-step.test.js
 * Note: This file mirrors steps/__tests__/task-review-step.test.js with adjusted
 * import paths. Required by spec verification checklist (FILE_EXISTS constraint).
 */

/* eslint-disable -- top-level test file, no additional lint rules needed */
'use strict';

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { STEPS } = require('../step-registry');

// ─── Test doubles ────────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    STEPS,
    ticket: 'TEST-100',
    tasksDir: '/tmp/tasks/TEST-100',
    path,
    // Implement step sets these on ctx for downstream steps
    _taskData: null,
    _allTasksDone: false,
    _currentTaskIdx: 0,
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    hasTasks: false,
    workState: null,
    ...overrides,
  };
}

function makeAdd() {
  const entries = [];
  const add = (step, action, command, reason, extra) => {
    entries.push({ step, action, command, reason, ...(extra || {}) });
  };
  return { add, entries };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('task-review step', () => {
  let taskReviewStep;
  const savedEnv = {};

  before(() => {
    taskReviewStep = require(path.join(__dirname, '..', 'steps', 'task-review.js'));
  });

  beforeEach(() => {
    savedEnv.TASK_REVIEW_ENABLED = process.env.TASK_REVIEW_ENABLED;
    savedEnv.TASK_REVIEW_MAX_FIXES = process.env.TASK_REVIEW_MAX_FIXES;
    delete process.env.TASK_REVIEW_ENABLED;
    delete process.env.TASK_REVIEW_MAX_FIXES;
  });

  afterEach(() => {
    if (savedEnv.TASK_REVIEW_ENABLED === undefined) delete process.env.TASK_REVIEW_ENABLED;
    else process.env.TASK_REVIEW_ENABLED = savedEnv.TASK_REVIEW_ENABLED;
    if (savedEnv.TASK_REVIEW_MAX_FIXES === undefined) delete process.env.TASK_REVIEW_MAX_FIXES;
    else process.env.TASK_REVIEW_MAX_FIXES = savedEnv.TASK_REVIEW_MAX_FIXES;
  });

  it('exports a function', () => {
    assert.equal(typeof taskReviewStep, 'function');
  });

  // ─── Decision 1: DEFER when disabled ───────────────────────────────────────

  it('DEFERs when TASK_REVIEW_ENABLED=0', () => {
    process.env.TASK_REVIEW_ENABLED = '0';
    const { add, entries } = makeAdd();
    const taskData = [
      { num: 1, title: 'Task A', isCheckpoint: false },
      { num: 2, title: 'Task B', isCheckpoint: false },
    ];
    const s = makeState({
      hasTasks: true,
      workState: { tasksMeta: { currentTaskIndex: 0, tasks: [{ id: 'task-1' }, { id: 'task-2' }] } },
    });
    const ctx = makeCtx({ _taskData: taskData, _currentTaskIdx: 0 });
    taskReviewStep(add, s, ctx);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.task_review);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /disabled/i);
  });

  // ─── Decision 2: DEFER when no tasks ──────────────────────────────────────

  it('DEFERs when no tasks (hasTasks=false)', () => {
    const { add, entries } = makeAdd();
    const s = makeState({ hasTasks: false });
    const ctx = makeCtx();
    taskReviewStep(add, s, ctx);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.task_review);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /no tasks/i);
  });

  it('DEFERs when no tasksMeta in workState', () => {
    const { add, entries } = makeAdd();
    const taskData = [{ num: 1, title: 'Task A', isCheckpoint: false }];
    const s = makeState({ hasTasks: true, workState: {} });
    const ctx = makeCtx({ _taskData: taskData, _currentTaskIdx: 0 });
    taskReviewStep(add, s, ctx);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.task_review);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /no tasks/i);
  });

  it('DEFERs when _taskData is null', () => {
    const { add, entries } = makeAdd();
    const s = makeState({
      hasTasks: true,
      workState: { tasksMeta: { currentTaskIndex: 0, tasks: [{ id: 'task-1' }] } },
    });
    const ctx = makeCtx({ _taskData: null });
    taskReviewStep(add, s, ctx);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.task_review);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /no tasks/i);
  });

  // ─── Decision 3: DEFER when final task ─────────────────────────────────────

  it('DEFERs when current task is the last task', () => {
    const { add, entries } = makeAdd();
    const taskData = [
      { num: 1, title: 'Task A', isCheckpoint: false },
      { num: 2, title: 'Task B', isCheckpoint: false },
    ];
    const s = makeState({
      hasTasks: true,
      workState: {
        tasksMeta: {
          currentTaskIndex: 1,
          tasks: [{ id: 'task-1' }, { id: 'task-2' }],
        },
      },
    });
    const ctx = makeCtx({ _taskData: taskData, _currentTaskIdx: 1 });
    taskReviewStep(add, s, ctx);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.task_review);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /final task/i);
  });

  it('DEFERs when single task (always the final task)', () => {
    const { add, entries } = makeAdd();
    const taskData = [{ num: 1, title: 'Only task', isCheckpoint: false }];
    const s = makeState({
      hasTasks: true,
      workState: {
        tasksMeta: {
          currentTaskIndex: 0,
          tasks: [{ id: 'task-1' }],
        },
      },
    });
    const ctx = makeCtx({ _taskData: taskData, _currentTaskIdx: 0 });
    taskReviewStep(add, s, ctx);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.task_review);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /final task/i);
  });

  // ─── Decision 4: RUN for intermediate task ────────────────────────────────

  it('RUNs for intermediate task needing review', () => {
    const { add, entries } = makeAdd();
    const taskData = [
      { num: 1, title: 'Task A', isCheckpoint: false },
      { num: 2, title: 'Task B', isCheckpoint: false },
      { num: 3, title: 'Task C', isCheckpoint: false },
    ];
    const s = makeState({
      hasTasks: true,
      workState: {
        tasksMeta: {
          currentTaskIndex: 0,
          tasks: [
            { id: 'task-1', taskReviewFixRounds: 0 },
            { id: 'task-2' },
            { id: 'task-3' },
          ],
        },
      },
    });
    const ctx = makeCtx({ _taskData: taskData, _currentTaskIdx: 0 });
    taskReviewStep(add, s, ctx);
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.step, STEPS.task_review);
    assert.equal(entry.action, 'RUN');
    assert.equal(typeof entry.agentType, 'string');
    assert.equal(typeof entry.agentPrompt, 'string');
    // Should reference both tests-review and code-review
    assert.match(entry.agentPrompt, /tests-review|code-review/i);
  });

  it('RUN entry includes task info in reason', () => {
    const { add, entries } = makeAdd();
    const taskData = [
      { num: 1, title: 'Task A', isCheckpoint: false },
      { num: 2, title: 'Task B', isCheckpoint: false },
    ];
    const s = makeState({
      hasTasks: true,
      workState: {
        tasksMeta: {
          currentTaskIndex: 0,
          tasks: [
            { id: 'task-1', taskReviewFixRounds: 0 },
            { id: 'task-2' },
          ],
        },
      },
    });
    const ctx = makeCtx({ _taskData: taskData, _currentTaskIdx: 0 });
    taskReviewStep(add, s, ctx);
    assert.equal(entries.length, 1);
    // Reason should mention task number or title
    assert.match(entries[0].reason, /task/i);
  });

  // ─── Decision 5: Escalation when max rounds exhausted ─────────────────────

  it('RUNs with AskUserQuestion escalation when max fix rounds exhausted', () => {
    const { add, entries } = makeAdd();
    const taskData = [
      { num: 1, title: 'Task A', isCheckpoint: false },
      { num: 2, title: 'Task B', isCheckpoint: false },
    ];
    const s = makeState({
      hasTasks: true,
      workState: {
        tasksMeta: {
          currentTaskIndex: 0,
          tasks: [
            { id: 'task-1', taskReviewFixRounds: 2 },
            { id: 'task-2' },
          ],
        },
      },
    });
    const ctx = makeCtx({ _taskData: taskData, _currentTaskIdx: 0 });
    taskReviewStep(add, s, ctx);
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.step, STEPS.task_review);
    assert.equal(entry.action, 'RUN');
    assert.equal(entry.command, 'AskUserQuestion');
    assert.match(entry.reason, /fix rounds|max.*exhaust|escalat/i);
  });

  it('respects TASK_REVIEW_MAX_FIXES env var for escalation threshold', () => {
    process.env.TASK_REVIEW_MAX_FIXES = '1';
    const { add, entries } = makeAdd();
    const taskData = [
      { num: 1, title: 'Task A', isCheckpoint: false },
      { num: 2, title: 'Task B', isCheckpoint: false },
    ];
    const s = makeState({
      hasTasks: true,
      workState: {
        tasksMeta: {
          currentTaskIndex: 0,
          tasks: [
            { id: 'task-1', taskReviewFixRounds: 1 },
            { id: 'task-2' },
          ],
        },
      },
    });
    const ctx = makeCtx({ _taskData: taskData, _currentTaskIdx: 0 });
    taskReviewStep(add, s, ctx);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].command, 'AskUserQuestion');
  });

  it('does NOT escalate when fix rounds below max', () => {
    const { add, entries } = makeAdd();
    const taskData = [
      { num: 1, title: 'Task A', isCheckpoint: false },
      { num: 2, title: 'Task B', isCheckpoint: false },
    ];
    const s = makeState({
      hasTasks: true,
      workState: {
        tasksMeta: {
          currentTaskIndex: 0,
          tasks: [
            { id: 'task-1', taskReviewFixRounds: 1 },
            { id: 'task-2' },
          ],
        },
      },
    });
    const ctx = makeCtx({ _taskData: taskData, _currentTaskIdx: 0 });
    taskReviewStep(add, s, ctx);
    assert.equal(entries.length, 1);
    // Default max is 2, fix rounds is 1, so should NOT escalate
    assert.notEqual(entries[0].command, 'AskUserQuestion');
  });

  // ─── STEP_PIPELINE registration ────────────────────────────────────────────

  describe('STEP_PIPELINE registration', () => {
    it('taskReviewStep is in STEP_PIPELINE between commitStep and checkStep', () => {
      const barrel = require(path.join(__dirname, '..', 'steps', 'index.js'));
      const commitStep = require(path.join(__dirname, '..', 'steps', 'commit.js'));
      const checkStep = require(path.join(__dirname, '..', 'steps', 'check.js'));
      const taskReview = require(path.join(__dirname, '..', 'steps', 'task-review.js'));

      assert.ok(Array.isArray(barrel.STEP_PIPELINE), 'STEP_PIPELINE should be an array');

      const commitIdx = barrel.STEP_PIPELINE.indexOf(commitStep);
      const reviewIdx = barrel.STEP_PIPELINE.indexOf(taskReview);
      const checkIdx = barrel.STEP_PIPELINE.indexOf(checkStep);

      assert.ok(commitIdx >= 0, 'commitStep must be in STEP_PIPELINE');
      assert.ok(reviewIdx >= 0, 'taskReviewStep must be in STEP_PIPELINE');
      assert.ok(checkIdx >= 0, 'checkStep must be in STEP_PIPELINE');
      assert.equal(reviewIdx, commitIdx + 1, 'taskReviewStep must come directly after commitStep');
      assert.equal(checkIdx, reviewIdx + 1, 'checkStep must come directly after taskReviewStep');
    });

    it('exports taskReviewStep as a named export', () => {
      const barrel = require(path.join(__dirname, '..', 'steps', 'index.js'));
      assert.equal(typeof barrel.taskReviewStep, 'function', 'steps/index.js should export taskReviewStep');
    });
  });
});
