'use strict';

// Skip delays in tests
process.env.FOLLOW_UP2_NO_DELAY = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { STEPS } = require('../lib/step-registry');
const followUpNext = require('../follow-up-next');

describe('step-registry — infra-retry wiring (Task 4)', () => {
  it('(a) STEPS deep-equals the documented 7-element ordered array', () => {
    assert.deepEqual(STEPS, [
      'monitor',
      'triage',
      'infra-retry',
      'fix-ci',
      'fix-reviews',
      'push-retry',
      'report',
    ]);
  });

  it('(b) initState() returns object with infraRetry default { count: 0, attempts: [] }', () => {
    assert.equal(
      typeof followUpNext.initState,
      'function',
      'follow-up-next must export initState for testability'
    );
    const state = followUpNext.initState('GH-508', null);
    assert.ok(state.infraRetry, 'initState must include infraRetry block');
    assert.equal(state.infraRetry.count, 0);
    assert.deepEqual(state.infraRetry.attempts, []);
  });

  it('(c) dispatchStepResult treats action:"surface" as terminal without status=complete', () => {
    assert.equal(
      typeof followUpNext.dispatchStepResult,
      'function',
      'follow-up-next must export dispatchStepResult for testability'
    );
    const state = {
      ticketId: 'GH-508',
      currentStep: 'infra-retry',
      status: 'in_progress',
    };
    const result = { action: 'surface', payload: { reason: 'infra exhausted' } };
    const decision = followUpNext.dispatchStepResult(state, result);
    assert.equal(decision.terminate, true, 'surface must set terminate=true');
    assert.notEqual(state.status, 'complete', 'surface must NOT mark state.status=complete');
  });
});
