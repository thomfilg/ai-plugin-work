'use strict';

// Skip delays in tests
process.env.FOLLOW_UP2_NO_DELAY = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Import triage step handler directly
const handlers = Object.create(null);
function registerStep(name, fn) {
  handlers[name] = fn;
}
require('../lib/steps/triage')(registerStep);
const triage = handlers['triage'];

function makeState(exitCode, output) {
  return {
    ticketId: 'GH-123',
    currentStep: 'triage',
    lastMonitorResult: { exitCode, output },
    failureCategory: null,
  };
}

describe('triage step', () => {
  it('routes CI failure to infra-retry (Bug A — infra-retry visited before fix-ci)', () => {
    const state = makeState(1, 'CI: FAILING\n  ✗ Test (Node 20) — FAILED');
    const result = triage(state, {});
    assert.equal(result, null);
    assert.equal(state.failureCategory, 'ci_failure');
    assert.equal(
      state.currentStep,
      'infra-retry',
      'STEPS order requires infra-retry before fix-ci; routing to fix-ci would skip retry gating'
    );
  });

  it('routes merge conflict to fix-ci', () => {
    const state = makeState(1, 'merge conflict detected');
    const result = triage(state, {});
    assert.equal(result, null);
    assert.equal(state.failureCategory, 'conflict');
    assert.equal(state.currentStep, 'fix-ci');
  });

  it('routes blocking reviews to fix-reviews', () => {
    const state = makeState(1, 'CI: PASSED\nReviews: 2 BLOCKING\n  ✗ @cursor[bot]');
    const result = triage(state, {});
    assert.equal(result, null);
    assert.equal(state.failureCategory, 'reviews');
    assert.equal(state.currentStep, 'fix-reviews');
  });

  it('loops back to monitor when bot is still reviewing', () => {
    const state = makeState(1, 'CI: PASSED\nReviews: Awaiting bot reviews');
    const result = triage(state, {});
    assert.equal(result, null);
    assert.equal(state.currentStep, 'monitor');
  });

  it('loops back to monitor when CI is pending', () => {
    const state = makeState(1, 'CI: PENDING (2 running, 3 passed)');
    const result = triage(state, {});
    assert.equal(result, null);
    assert.equal(state.currentStep, 'monitor');
  });

  it('treats CI cancelled as passing when merge not blocked', () => {
    const state = makeState(1, 'CI: CANCELLED\nReviews: CLEAR');
    const result = triage(state, {});
    assert.equal(result, null);
    assert.equal(state.currentStep, 'report');
  });

  it('routes CI cancelled to infra-retry when merge is blocked and no reviews', () => {
    const state = makeState(1, 'CI: CANCELLED\nMERGE STATUS: BLOCKED');
    const result = triage(state, {});
    assert.equal(result, null);
    assert.equal(state.failureCategory, 'ci_cancelled_blocking');
    assert.equal(state.currentStep, 'infra-retry');
  });

  it('does NOT route CI cancelled to fix-ci when reviews are blocking', () => {
    const state = makeState(1, 'CI: CANCELLED\nMERGE STATUS: BLOCKED\nReviews: 1 BLOCKING');
    const result = triage(state, {});
    assert.equal(result, null);
    assert.equal(state.failureCategory, 'reviews');
    assert.equal(state.currentStep, 'fix-reviews');
  });

  it('returns blocked on monitor error (exit 2)', () => {
    const state = makeState(2, 'Error: gh CLI not found');
    const result = triage(state, {});
    assert.equal(result.action, 'blocked');
    assert.ok(result.reason.includes('Monitor error'));
  });

  it('routes to report when CI passed and no reviews', () => {
    const state = makeState(1, 'CI: PASSED\nReviews: CLEAR');
    const result = triage(state, {});
    assert.equal(result, null);
    assert.equal(state.currentStep, 'report');
  });

  it('conflict takes priority over CI failure', () => {
    const state = makeState(1, 'CI: FAILING\nmerge conflict');
    const result = triage(state, {});
    assert.equal(state.failureCategory, 'conflict');
  });

  it('CI failure takes priority over blocking reviews', () => {
    const state = makeState(1, 'CI: FAILING\nReviews: 1 BLOCKING');
    const result = triage(state, {});
    assert.equal(state.failureCategory, 'ci_failure');
    assert.equal(state.currentStep, 'infra-retry');
  });

  it('blocking reviews take priority over CI pending', () => {
    const state = makeState(1, 'CI: PENDING\nReviews: 1 BLOCKING');
    triage(state, {});
    assert.equal(state.failureCategory, 'reviews');
    assert.equal(state.currentStep, 'fix-reviews');
  });
});
