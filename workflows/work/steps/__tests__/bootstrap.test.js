/**
 * Unit tests for the bootstrap step module.
 *
 * Run: node --test workflows/work/steps/__tests__/bootstrap.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { STEPS } = require('../../step-registry');

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
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    worktreeExists: false,
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

describe('bootstrap step', () => {
  let bootstrapStep;
  before(() => {
    bootstrapStep = require(path.join(__dirname, '..', 'bootstrap.js'));
  });

  it('exports a function', () => {
    assert.equal(typeof bootstrapStep, 'function');
  });

  it('SKIPs when worktree + PR both exist', () => {
    const { add, entries } = makeAdd();
    const s = makeState({ worktreeExists: true, pr: { number: 42 } });
    bootstrapStep(add, s, makeCtx());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.bootstrap);
    assert.equal(entries[0].action, 'SKIP');
    assert.match(entries[0].reason, /PR #42/);
  });

  it('RUNs with ticket name when worktree exists but PR missing', () => {
    const { add, entries } = makeAdd();
    const s = makeState({ worktreeExists: true, pr: null });
    bootstrapStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'RUN');
    assert.match(entries[0].command, /\/bootstrap TEST-100/);
    assert.equal(entries[0].reason, 'Worktree exists but no PR');
    assert.equal(entries[0].agentType, 'skill');
    assert.match(entries[0].agentPrompt, /\/bootstrap TEST-100/);
  });

  it('RUNs with placeholder when no worktree exists', () => {
    const { add, entries } = makeAdd();
    const s = makeState({ worktreeExists: false });
    const ctx = makeCtx({ ticket: null, t: '{TICKET}', description: 'add login' });
    bootstrapStep(add, s, ctx);
    assert.equal(entries[0].action, 'RUN');
    assert.match(entries[0].command, /\/bootstrap \{TICKET\}/);
    assert.equal(entries[0].reason, 'No worktree found');
  });

  it('handles null state defensively (no worktree path)', () => {
    const { add, entries } = makeAdd();
    bootstrapStep(add, null, makeCtx());
    assert.equal(entries[0].action, 'RUN');
    assert.equal(entries[0].reason, 'No worktree found');
  });
});
