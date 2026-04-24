/**
 * task-advance.test.js — Tests for task-advance.js (GH-211 Task 6)
 *
 * Covers:
 *   - Mutates task_review plan entry when more tasks remain
 *   - Calls resetTaskReviewFixRounds on advance
 *   - Does not mutate task_review when all tasks done
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const taskAdvanceStep = require(path.join(__dirname, '..', 'steps', 'task-advance'));
const { STEPS } = require(path.join(__dirname, '..', 'step-registry'));

describe('task-advance: mutates task_review plan entry', () => {
  it('sets nextAction on task_review entry when more tasks remain', () => {
    const plan = [{ step: STEPS.check }, { step: STEPS.task_review }];
    const ctx = {
      STEPS,
      plan,
      _taskData: [{ title: 'Task 1' }, { title: 'Task 2' }, { title: 'Task 3' }],
      _allTasksDone: false,
      _currentTaskIdx: 0,
    };

    taskAdvanceStep(() => {}, {}, ctx);

    const taskReviewEntry = plan.find((p) => p.step === STEPS.task_review);
    assert.ok(taskReviewEntry, 'task_review entry should exist');
    assert.equal(
      taskReviewEntry.nextAction,
      'advance_task',
      'task_review entry should have nextAction = advance_task'
    );
    assert.ok(taskReviewEntry.taskInfo, 'task_review entry should have taskInfo');
    assert.equal(taskReviewEntry.taskInfo.current, 1);
    assert.equal(taskReviewEntry.taskInfo.total, 3);
    assert.equal(taskReviewEntry.taskInfo.nextTask, 'Task 2');
  });

  it('does NOT set nextAction on task_review when all tasks are done', () => {
    const plan = [{ step: STEPS.check }, { step: STEPS.task_review }];
    const ctx = {
      STEPS,
      plan,
      _taskData: [{ title: 'Task 1' }],
      _allTasksDone: false,
      _currentTaskIdx: 0, // last task (index 0 of 1)
    };

    taskAdvanceStep(() => {}, {}, ctx);

    const taskReviewEntry = plan.find((p) => p.step === STEPS.task_review);
    assert.ok(taskReviewEntry);
    assert.equal(
      taskReviewEntry.nextAction,
      undefined,
      'task_review should NOT have nextAction when on last task'
    );
  });

  it('does NOT set nextAction on task_review when _allTasksDone is true', () => {
    const plan = [{ step: STEPS.check }, { step: STEPS.task_review }];
    const ctx = {
      STEPS,
      plan,
      _taskData: [{ title: 'Task 1' }, { title: 'Task 2' }],
      _allTasksDone: true,
      _currentTaskIdx: 0,
    };

    taskAdvanceStep(() => {}, {}, ctx);

    const taskReviewEntry = plan.find((p) => p.step === STEPS.task_review);
    assert.ok(taskReviewEntry);
    assert.equal(taskReviewEntry.nextAction, undefined);
  });

  it('still mutates check entry alongside task_review (backward compat)', () => {
    const plan = [{ step: STEPS.check }, { step: STEPS.task_review }];
    const ctx = {
      STEPS,
      plan,
      _taskData: [{ title: 'Task 1' }, { title: 'Task 2' }],
      _allTasksDone: false,
      _currentTaskIdx: 0,
    };

    taskAdvanceStep(() => {}, {}, ctx);

    const checkEntry = plan.find((p) => p.step === STEPS.check);
    assert.equal(checkEntry.nextAction, 'advance_task', 'check entry should still be mutated');
  });

  it('handles missing task_review entry gracefully', () => {
    const plan = [{ step: STEPS.check }];
    const ctx = {
      STEPS,
      plan,
      _taskData: [{ title: 'Task 1' }, { title: 'Task 2' }],
      _allTasksDone: false,
      _currentTaskIdx: 0,
    };

    // Should not throw
    taskAdvanceStep(() => {}, {}, ctx);
    assert.equal(plan.find((p) => p.step === STEPS.check).nextAction, 'advance_task');
  });
});

// Note: Fix-round reset is performed by work-state.js advanceTask() directly
// (see work-state.test.js for coverage), NOT by this step module.
// This step module only mutates plan entries during plan generation.
