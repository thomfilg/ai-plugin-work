/**
 * Unit tests for the tasks step module (GH-253, Task 1).
 *
 * Verifies that:
 * - The tasks step never DEFERs with a "disabled" reason (toggle removed)
 * - Setting WORK_TASKS_ENABLED=0 has no effect
 * - Step DEFERs when tasks.md already exists
 * - Step RUNs when spec.md exists and tasks.md is missing
 * - Step DEFERs when spec.md is missing (cannot generate tasks)
 *
 * Run: node --test workflows/work/steps/__tests__/tasks.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { STEPS } = require('../../step-registry');
const tasksStep = require('../tasks.js');

// ─── Test doubles ────────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    STEPS,
    ticket: 'TEST-100',
    description: null,
    rework: false,
    safeName: 'TEST-100',
    worktreeDir: '/tmp/worktrees/my-project-TEST-100',
    tasksDir: '/tmp/tasks/TEST-100',
    t: 'TEST-100',
    path,
    fileExists: () => false,
    getDocsPrompt: () => '',
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    worktreeExists: true,
    hasTasks: false,
    pr: null,
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

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('tasks step (GH-253)', () => {
  const originalEnv = process.env.WORK_TASKS_ENABLED;

  beforeEach(() => {
    delete process.env.WORK_TASKS_ENABLED;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WORK_TASKS_ENABLED;
    else process.env.WORK_TASKS_ENABLED = originalEnv;
  });

  it('never DEFERs with a "disabled" reason even when WORK_TASKS_ENABLED=0', () => {
    process.env.WORK_TASKS_ENABLED = '0';

    const { add, entries } = makeAdd();
    const ctx = makeCtx({ fileExists: () => true });
    tasksStep(add, makeState(), ctx);
    assert.equal(entries.length, 1);
    const entry = entries[0];
    if (entry.action === 'DEFER') {
      assert.ok(
        !entry.reason.toLowerCase().includes('disabled'),
        `tasks step must not DEFER with "disabled" reason, got: "${entry.reason}"`
      );
    }
  });

  it('does not reference WORK_TASKS_ENABLED in source code', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'tasks.js'), 'utf8');
    assert.ok(
      !source.includes('WORK_TASKS_ENABLED'),
      'tasks.js must not contain WORK_TASKS_ENABLED'
    );
  });

  it('DEFERs when tasks.md already exists (hasTasks=true)', () => {
    const { add, entries } = makeAdd();
    tasksStep(add, makeState({ hasTasks: true }), makeCtx());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.tasks);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason.toLowerCase(), /already exists/);
  });

  it('RUNs when spec.md exists and tasks.md is missing', () => {
    const { add, entries } = makeAdd();
    const ctx = makeCtx({ fileExists: () => true });
    tasksStep(add, makeState({ hasTasks: false }), ctx);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.tasks);
    assert.equal(entries[0].action, 'RUN');
  });

  it('DEFERs when spec.md is missing (cannot generate tasks)', () => {
    const { add, entries } = makeAdd();
    const ctx = makeCtx({ fileExists: () => false });
    tasksStep(add, makeState({ hasTasks: false }), ctx);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.tasks);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason.toLowerCase(), /spec/);
  });

  it('still RUNs when WORK_TASKS_ENABLED=0 and spec exists', () => {
    process.env.WORK_TASKS_ENABLED = '0';

    const { add, entries } = makeAdd();
    const ctx = makeCtx({ fileExists: () => true });
    tasksStep(add, makeState({ hasTasks: false }), ctx);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'RUN');
  });

  it('RUNs with correct agent type and prompt', () => {
    const { add, entries } = makeAdd();
    const ctx = makeCtx({ fileExists: () => true });
    tasksStep(add, makeState({ hasTasks: false }), ctx);
    assert.equal(entries[0].agentType, 'skill');
    assert.match(entries[0].agentPrompt, /split-in-tasks/);
  });
});
