/**
 * Unit tests for the pr step module.
 *
 * Run: node --test workflows/work/steps/__tests__/pr.test.js
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
    rework: false,
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    pr: null,
    headSha: 'abcdef1234567890',
    prUpdateSha: null,
    postPrUpdateSha: null,
    prEverUpdated: false,
    prShaMatch: false,
    postPrShaMatch: false,
    contentSha: null,
    ...overrides,
  };
}

describe('pr step', () => {
  let prStep;
  before(() => {
    prStep = require(path.join(__dirname, '..', 'pr.js'));
  });

  it('exports a function', () => {
    assert.equal(typeof prStep, 'function');
  });

  it('RUNs --force in rework mode', () => {
    const { add, entries } = makeAdd();
    const ctx = makeCtx({ rework: true });
    prStep(add, makeState(), ctx);
    assert.equal(entries[0].step, STEPS.pr);
    assert.equal(entries[0].action, 'RUN');
    assert.match(entries[0].command, /--force/);
    assert.match(entries[0].reason, /REWORK/);
  });

  it('RUNs with "Must run once" reason when PR never updated', () => {
    const { add, entries } = makeAdd();
    const s = makeState({ prEverUpdated: false });
    prStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'RUN');
    assert.equal(entries[0].reason, 'Must run once');
  });

  it('DEFERs when SHA matches and content is up to date', () => {
    const { add, entries } = makeAdd();
    const s = makeState({
      prEverUpdated: true,
      prShaMatch: true,
      postPrShaMatch: true,
      contentSha: 'content-sha-1',
      headSha: 'abcdef1234567890',
    });
    prStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /SHA match/);
  });

  it('DEFERs when SHA matches and no contentSha tracking', () => {
    const { add, entries } = makeAdd();
    const s = makeState({
      prEverUpdated: true,
      prShaMatch: true,
      postPrShaMatch: false,
      contentSha: null,
      headSha: '1234567890abcdef',
    });
    prStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'DEFER');
  });

  it('RUNs when PR updated but HEAD has moved forward', () => {
    const { add, entries } = makeAdd();
    const s = makeState({
      prEverUpdated: true,
      prShaMatch: false,
      prUpdateSha: 'oldsha12',
      headSha: 'newsha34abcdef',
    });
    prStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'RUN');
    assert.match(entries[0].reason, /HEAD:/);
  });

  it('handles null state with defaults (RUN must run once)', () => {
    const { add, entries } = makeAdd();
    prStep(add, null, makeCtx());
    assert.equal(entries[0].action, 'RUN');
    assert.equal(entries[0].reason, 'Must run once');
  });
});
