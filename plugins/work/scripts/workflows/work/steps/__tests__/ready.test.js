/**
 * Unit tests for the ready step module.
 *
 * Run: node --test scripts/workflows/work/steps/__tests__/ready.test.js
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
    ticket: 'GH-395',
    t: 'GH-395',
    worktreeDir: '/tmp/wt/GH-395',
    ...overrides,
  };
}

describe('ready step', () => {
  let readyStep;
  before(() => {
    readyStep = require(path.join(__dirname, '..', 'ready.js'));
  });

  it('exports a function', () => {
    assert.equal(typeof readyStep, 'function');
  });

  it('ready step emits runnable command', () => {
    const { add, entries } = makeAdd();
    readyStep(add, { pr: { isDraft: true } }, makeCtx());
    assert.equal(entries[0].step, STEPS.ready);
    assert.equal(entries[0].action, 'RUN');
    const prompt = entries[0].agentPrompt;
    assert.ok(
      prompt.includes('cd "/tmp/wt/GH-395" && gh pr ready'),
      `expected runnable cd && gh pr ready form, got: ${prompt}`
    );
    assert.ok(
      !prompt.includes('Run in /tmp/wt/GH-395:'),
      `prompt should not contain prose preamble "Run in /tmp/wt/GH-395:", got: ${prompt}`
    );
  });

  it('DEFERs when PR is already not a draft', () => {
    const { add, entries } = makeAdd();
    readyStep(add, { pr: { isDraft: false } }, makeCtx());
    assert.equal(entries[0].action, 'DEFER');
  });
});
