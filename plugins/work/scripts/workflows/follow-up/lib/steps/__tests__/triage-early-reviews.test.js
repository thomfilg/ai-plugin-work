'use strict';

// triage-early-reviews.test.js — GH-268: actionable review comments are
// surfaced BEFORE the CI wait. When a bot has submitted its review (done, not
// in-progress) and blocking comments exist, triage routes to fix-reviews even
// while CI is still pending. When the review is still in progress, triage
// keeps waiting (no partial reviews surfaced).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

function loadTriageHandler() {
  const handlers = {};
  delete require.cache[require.resolve('../triage')];
  require('../triage')((name, fn) => {
    handlers[name] = fn;
  });
  return handlers.triage;
}

describe('triage — early review surfacing (GH-268)', () => {
  beforeEach(() => {
    process.env.FOLLOW_UP2_NO_DELAY = '1';
  });

  afterEach(() => {
    delete process.env.FOLLOW_UP2_NO_DELAY;
  });

  function run(output) {
    const triage = loadTriageHandler();
    const state = {
      ticketId: 'GH-268',
      attempt: 1,
      maxAttempts: 40,
      lastMonitorResult: { exitCode: 1, output },
    };
    const result = triage(state, {});
    return { state, result };
  }

  it('routes to fix-reviews while CI is still PENDING when the bot review is submitted', () => {
    const { state } = run('CI: PENDING\nReviews: 2 BLOCKING');
    assert.equal(state.currentStep, 'fix-reviews', 'reviews must preempt the CI wait');
    assert.equal(state.failureCategory, 'reviews');
  });

  it('keeps waiting when the bot review is still in progress (no partial reviews)', () => {
    const { state } = run('CI: PENDING\nReviews: 2 BLOCKING\nCursor Bugbot — running');
    assert.equal(state.currentStep, 'monitor', 'in-progress review falls back to waiting');
  });

  it('keeps waiting on CI when there are no blocking reviews', () => {
    const { state } = run('CI: PENDING\nReviews: CLEAR');
    assert.equal(state.currentStep, 'monitor');
  });
});
