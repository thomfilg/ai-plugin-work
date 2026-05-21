/**
 * Unit tests for the commit step module.
 *
 * Run: node --test workflows/work/steps/__tests__/commit.test.js
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
    hasUncommitted: false,
    uncommittedCount: 0,
    hasCommitWithTicket: false,
    hasDiffVsMain: false,
    lastCommitMsg: '',
    ...overrides,
  };
}

describe('commit step', () => {
  let commitStep;
  before(() => {
    commitStep = require(path.join(__dirname, '..', 'commit.js'));
  });

  it('exports a function', () => {
    assert.equal(typeof commitStep, 'function');
  });

  it('RUNs when uncommitted files exist with count in reason', () => {
    const { add, entries } = makeAdd();
    const s = makeState({ hasUncommitted: true, uncommittedCount: 5 });
    commitStep(add, s, makeCtx());
    assert.equal(entries[0].step, STEPS.commit);
    assert.equal(entries[0].action, 'RUN');
    assert.match(entries[0].reason, /5 uncommitted file/);
    assert.equal(entries[0].agentType, 'commit-writer');
    assert.match(entries[0].agentPrompt, /autonomous/);
    assert.match(entries[0].agentPrompt, /TEST-100/);
  });

  it('DEFERs when a previous commit already has ticket ID', () => {
    const { add, entries } = makeAdd();
    const s = makeState({
      hasUncommitted: false,
      hasCommitWithTicket: true,
      lastCommitMsg: 'feat(TEST-100): add feature',
    });
    commitStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /feat\(TEST-100\)/);
  });

  it('is PENDING when no diff vs main (nothing to commit yet)', () => {
    const { add, entries } = makeAdd();
    const s = makeState({ hasUncommitted: false, hasDiffVsMain: false });
    commitStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'PENDING');
    assert.match(entries[0].reason, /Depends on implement/);
  });

  it('RUNs when diff exists but commit lacks ticket ID', () => {
    const { add, entries } = makeAdd();
    const s = makeState({
      hasUncommitted: false,
      hasDiffVsMain: true,
      hasCommitWithTicket: false,
    });
    commitStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'RUN');
    assert.match(entries[0].reason, /Commit missing ticket ID/);
  });

  it('prefers uncommitted RUN over commit-missing-ticket RUN', () => {
    const { add, entries } = makeAdd();
    const s = makeState({
      hasUncommitted: true,
      uncommittedCount: 2,
      hasDiffVsMain: true,
    });
    commitStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'RUN');
    assert.match(entries[0].reason, /2 uncommitted/);
  });

  it('handles null state as PENDING (nothing to commit)', () => {
    const { add, entries } = makeAdd();
    commitStep(add, null, makeCtx());
    assert.equal(entries[0].action, 'PENDING');
  });
});
