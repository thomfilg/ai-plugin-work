'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createPlanMutatorStep } = require('../createPlanMutatorStep');

function ctxWithPlan(plan) {
  return { plan, STEPS: { check: 'check', task_review: 'task_review' } };
}

describe('createPlanMutatorStep', () => {
  it('rejects bad config', () => {
    assert.throws(() => createPlanMutatorStep({}), /missing "id"/);
    assert.throws(() => createPlanMutatorStep({ id: 'p', mutations: [] }), /non-empty array/);
    assert.throws(
      () =>
        createPlanMutatorStep({
          id: 'p',
          mutations: [{ id: 'm', targetStepIds: ['check'] }],
        }),
      /predicate\(s,ctx\)/
    );
    assert.throws(
      () =>
        createPlanMutatorStep({
          id: 'p',
          mutations: [
            {
              id: 'm',
              targetStepIds: [],
              predicate: () => true,
              patch: () => ({}),
            },
          ],
        }),
      /non-empty targetStepIds/
    );
  });

  it('precondition false → no mutation, no plan entry', () => {
    const ctx = ctxWithPlan([{ step: 'check' }]);
    const calls = [];
    const step = createPlanMutatorStep({
      id: 'p',
      precondition: () => false,
      mutations: [
        {
          id: 'm',
          targetStepIds: ['check'],
          predicate: () => {
            calls.push('predicate');
            return true;
          },
          patch: () => ({ touched: true }),
        },
      ],
    });
    step(() => calls.push('add'), {}, ctx);
    assert.deepEqual(calls, []);
    assert.equal(ctx.plan[0].touched, undefined);
  });

  it('applies patch to entries matching targetStepIds', () => {
    const ctx = ctxWithPlan([
      { step: 'check', existing: true },
      { step: 'task_review' },
      { step: 'commit' },
    ]);
    const step = createPlanMutatorStep({
      id: 'p',
      mutations: [
        {
          id: 'advance',
          targetStepIds: ['check', 'task_review'],
          predicate: () => true,
          patch: (entry) => ({ nextAction: 'advance_task', from: entry.step }),
        },
      ],
    });
    step(() => undefined, {}, ctx);
    assert.equal(ctx.plan[0].nextAction, 'advance_task');
    assert.equal(ctx.plan[0].existing, true);
    assert.equal(ctx.plan[1].nextAction, 'advance_task');
    assert.equal(ctx.plan[2].nextAction, undefined);
  });

  it('predicate false → mutation skipped', () => {
    const ctx = ctxWithPlan([{ step: 'check' }]);
    const step = createPlanMutatorStep({
      id: 'p',
      mutations: [
        {
          id: 'never',
          targetStepIds: ['check'],
          predicate: () => false,
          patch: () => ({ touched: true }),
        },
      ],
    });
    step(() => undefined, {}, ctx);
    assert.equal(ctx.plan[0].touched, undefined);
  });

  it('patch throws → mutation skipped for that entry only', () => {
    const ctx = ctxWithPlan([
      { step: 'check', n: 1 },
      { step: 'check', n: 2 },
    ]);
    const step = createPlanMutatorStep({
      id: 'p',
      mutations: [
        {
          id: 'm',
          targetStepIds: ['check'],
          predicate: () => true,
          patch: (entry) => {
            if (entry.n === 1) throw new Error('boom');
            return { ok: true };
          },
        },
      ],
    });
    step(() => undefined, {}, ctx);
    assert.equal(ctx.plan[0].ok, undefined);
    assert.equal(ctx.plan[1].ok, true);
  });

  it('models task-advance.js: mutates check & task_review when more tasks remain', () => {
    const ctx = {
      plan: [{ step: 'check' }, { step: 'task_review' }, { step: 'commit' }],
      _taskData: [{ title: 't1' }, { title: 't2' }, { title: 't3' }],
      _currentTaskIdx: 1,
      _allTasksDone: false,
    };
    const step = createPlanMutatorStep({
      id: 'task_advance',
      mutations: [
        {
          id: 'more-tasks',
          targetStepIds: ['check', 'task_review'],
          predicate: (_s, c) => !c._allTasksDone && c._currentTaskIdx < c._taskData.length - 1,
          patch: (_e, _s, c) => ({
            nextAction: 'advance_task',
            taskInfo: {
              current: c._currentTaskIdx + 1,
              total: c._taskData.length,
              nextTask: c._taskData[c._currentTaskIdx + 1].title,
            },
          }),
        },
        {
          id: 'last-task',
          targetStepIds: ['check'],
          predicate: (_s, c) => !c._allTasksDone && c._currentTaskIdx === c._taskData.length - 1,
          patch: () => ({ finalTaskAction: 'complete_last_task' }),
        },
      ],
    });
    step(() => undefined, {}, ctx);
    assert.equal(ctx.plan[0].nextAction, 'advance_task');
    assert.equal(ctx.plan[0].taskInfo.nextTask, 't3');
    assert.equal(ctx.plan[1].nextAction, 'advance_task');
    assert.equal(ctx.plan[2].nextAction, undefined); // commit untouched
    assert.equal(ctx.plan[0].finalTaskAction, undefined); // not last task
  });
});
