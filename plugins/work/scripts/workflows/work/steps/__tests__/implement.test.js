/**
 * Unit tests for the implement step module.
 *
 * Run: node --test workflows/work/steps/__tests__/implement.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { STEPS } = require('../../step-registry');

function makeAdd() {
  const entries = [];
  const add = (step, action, command, reason, extra) => {
    entries.push({ step, action, command, reason, ...(extra || {}) });
  };
  return { add, entries };
}

function makeCtx(overrides = {}) {
  return {
    STEPS,
    ticket: 'TEST-100',
    safeName: 'TEST-100',
    tasksDir: '/tmp/tasks/TEST-100',
    planningContext: '',
    getDocsPrompt: () => '',
    parseTasks: () => null,
    buildTaskPrompt: (task) => `task ${task.num}: ${task.title}`,
    fileExists: () => false,
    path,
    execFileSync: () => '',
    workStatePath: '/tmp/work-state.js',
    rework: false,
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    hasTasks: false,
    hasDiffVsMain: false,
    diffSummary: 'no changes',
    workState: null,
    stepIs: () => 'unknown',
    ...overrides,
  };
}

describe('implement step', () => {
  let implementStep;
  before(() => {
    implementStep = require(path.join(__dirname, '..', 'implement.js'));
  });

  it('exports a function', () => {
    assert.equal(typeof implementStep, 'function');
  });

  it('RUNs with generic requirements when no tasks.md', () => {
    const { add, entries } = makeAdd();
    const ctx = makeCtx();
    const s = makeState();
    implementStep(add, s, ctx);
    assert.equal(entries[0].step, STEPS.implement);
    assert.equal(entries[0].action, 'RUN');
    assert.match(entries[0].agentPrompt, /<requirements>/);
    assert.equal(entries[0].agentType, 'skill');
  });

  it('RUNs with task prompt when tasks.md exists and task 1 is current', () => {
    const { add, entries } = makeAdd();
    const fakeTasks = [
      { num: 1, title: 'First task', isCheckpoint: false },
      { num: 2, title: 'Second task', isCheckpoint: false },
    ];
    const ctx = makeCtx({ parseTasks: () => fakeTasks });
    const s = makeState({
      hasTasks: true,
      workState: { tasksMeta: { currentTaskIndex: 0 } },
    });
    implementStep(add, s, ctx);
    assert.equal(entries[0].action, 'RUN');
    assert.match(entries[0].reason, /Task 1\/2 \(task_1\): First task/);
    assert.match(entries[0].agentPrompt, /task 1: First task/);
  });

  it('DEFERs when all tasks are done', () => {
    const { add, entries } = makeAdd();
    const fakeTasks = [{ num: 1, title: 'Only task', isCheckpoint: false }];
    const ctx = makeCtx({ parseTasks: () => fakeTasks });
    const s = makeState({
      hasTasks: true,
      workState: { tasksMeta: { currentTaskIndex: 1 } },
    });
    implementStep(add, s, ctx);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /All tasks completed/);
  });

  it('DEFERs checkpoint tasks without running implementation', () => {
    const { add, entries } = makeAdd();
    const fakeTasks = [{ num: 1, title: 'Review', isCheckpoint: true }];
    const ctx = makeCtx({ parseTasks: () => fakeTasks });
    const s = makeState({
      hasTasks: true,
      workState: { tasksMeta: { currentTaskIndex: 0 } },
    });
    implementStep(add, s, ctx);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /checkpoint/);
  });

  it('DEFERs when implement previously completed and diff exists', () => {
    const { add, entries } = makeAdd();
    const ctx = makeCtx();
    const s = makeState({
      hasDiffVsMain: true,
      diffSummary: '3 files changed',
      stepIs: (step) => (step === STEPS.implement ? 'completed' : 'unknown'),
    });
    implementStep(add, s, ctx);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /Previously completed/);
    assert.match(entries[0].reason, /3 files changed/);
  });

  it('exports task metadata back onto ctx for later steps', () => {
    const { add } = makeAdd();
    const fakeTasks = [
      { num: 1, title: 'First', isCheckpoint: false },
      { num: 2, title: 'Second', isCheckpoint: false },
    ];
    const ctx = makeCtx({ parseTasks: () => fakeTasks });
    const s = makeState({
      hasTasks: true,
      workState: { tasksMeta: { currentTaskIndex: 1 } },
    });
    implementStep(add, s, ctx);
    assert.deepEqual(ctx._taskData, fakeTasks);
    assert.equal(ctx._allTasksDone, false);
    assert.equal(ctx._currentTaskIdx, 1);
  });

  it('clamps out-of-range task index to last task', () => {
    const { add, entries } = makeAdd();
    const fakeTasks = [
      { num: 1, title: 'A', isCheckpoint: false },
      { num: 2, title: 'B', isCheckpoint: false },
    ];
    const ctx = makeCtx({ parseTasks: () => fakeTasks });
    // currentTaskIndex too large but not past length -> allTasksDone
    const s = makeState({
      hasTasks: true,
      workState: { tasksMeta: { currentTaskIndex: 5 } },
    });
    implementStep(add, s, ctx);
    assert.equal(entries[0].action, 'DEFER');
    assert.equal(ctx._allTasksDone, true);
  });
});
