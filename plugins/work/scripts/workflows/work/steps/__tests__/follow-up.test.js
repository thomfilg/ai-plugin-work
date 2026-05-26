/**
 * Unit tests for the follow-up step module.
 *
 * Run: node --test workflows/work/steps/__tests__/follow-up.test.js
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
    t: 'TEST-100',
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    pr: null,
    ...overrides,
  };
}

describe('follow-up step', () => {
  let followUpStep;
  before(() => {
    followUpStep = require(path.join(__dirname, '..', 'follow-up.js'));
  });

  it('exports a function', () => {
    assert.equal(typeof followUpStep, 'function');
  });

  it('DEFERs when no PR exists', () => {
    const { add, entries } = makeAdd();
    followUpStep(add, makeState({ pr: null }), makeCtx());
    assert.equal(entries[0].step, STEPS.follow_up);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /No PR exists/);
    assert.equal(entries[0].agentType, 'skill');
    assert.match(entries[0].agentPrompt, /\/follow-up-pr/);
  });

  it('DEFERs when PR is still a draft', () => {
    const { add, entries } = makeAdd();
    const s = makeState({ pr: { number: 5, isDraft: true } });
    followUpStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /draft/);
  });

  it('RUNs when PR exists and is not a draft', () => {
    const { add, entries } = makeAdd();
    const s = makeState({ pr: { number: 5, isDraft: false } });
    followUpStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'RUN');
    assert.match(entries[0].reason, /bot review/);
    assert.equal(entries[0].agentType, 'skill');
    assert.match(entries[0].agentPrompt, /\/follow-up-pr/);
  });

  it('handles null state as DEFER (no PR)', () => {
    const { add, entries } = makeAdd();
    followUpStep(add, null, makeCtx());
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /No PR exists/);
  });

  it('treats PR with undefined isDraft as runnable', () => {
    const { add, entries } = makeAdd();
    const s = makeState({ pr: { number: 9 } });
    followUpStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'RUN');
  });
});
