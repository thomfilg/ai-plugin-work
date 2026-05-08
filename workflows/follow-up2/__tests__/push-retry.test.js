'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');

// Import push-retry step handler
const handlers = Object.create(null);
function registerStep(name, fn) {
  handlers[name] = fn;
}
require('../lib/steps/push-retry')(registerStep);
const pushRetry = handlers['push-retry'];

function makeState(overrides = {}) {
  return {
    ticketId: 'GH-123',
    currentStep: 'push-retry',
    dispatched: null,
    attempt: 0,
    maxAttempts: 40,
    failureCategory: null,
    ...overrides,
  };
}

const ctx = { worktreeDir: '/tmp/test-worktree' };

describe('push-retry step', () => {
  it('blocks after max attempts', () => {
    const state = makeState({ attempt: 39, maxAttempts: 40 });
    const result = pushRetry(state, ctx);
    assert.equal(result.action, 'blocked');
    assert.ok(result.reason.includes('Max attempts'));
  });

  it('loops back to monitor when already dispatched', () => {
    const state = makeState({ dispatched: 'push-retry' });
    const result = pushRetry(state, ctx);
    assert.equal(result, null);
    assert.equal(state.currentStep, 'monitor');
    assert.equal(state.dispatched, null);
    assert.equal(state.failureCategory, null);
  });

  it('increments attempt counter', () => {
    const state = makeState({ attempt: 5, dispatched: 'push-retry' });
    pushRetry(state, ctx);
    assert.equal(state.attempt, 6);
  });
});
