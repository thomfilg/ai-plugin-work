/**
 * Tests for plan validation safety net (GH-245 Task 8)
 *
 * Verifies that validatePlan() rejects any plan entry with action === 'SKIP'
 * and passes plans with only RUN/DEFER entries.
 *
 * Uses node:test + node:assert/strict.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('validatePlan (GH-245 Task 8)', () => {
  it('should export validatePlan as a function', () => {
    const { validatePlan } = require('../plan-generator');
    assert.equal(typeof validatePlan, 'function', 'plan-generator must export validatePlan');
  });

  it('should throw for a plan containing a SKIP action', () => {
    const { validatePlan } = require('../plan-generator');

    const plan = [
      { step: 'ticket', action: 'RUN', reason: 'needed' },
      { step: 'bootstrap', action: 'SKIP', reason: 'already done' },
      { step: 'brief', action: 'DEFER', reason: 'deferred' },
    ];

    assert.throws(
      () => validatePlan(plan),
      (err) => {
        assert.ok(err instanceof Error, 'Should throw an Error');
        assert.ok(
          err.message.includes('bootstrap'),
          'Error message should include the step name "bootstrap"'
        );
        assert.ok(
          err.message.includes('SKIP'),
          'Error message should mention SKIP'
        );
        return true;
      },
      'validatePlan should throw for plan with SKIP action'
    );
  });

  it('should not throw for a plan with only RUN and DEFER actions', () => {
    const { validatePlan } = require('../plan-generator');

    const plan = [
      { step: 'ticket', action: 'RUN', reason: 'needed' },
      { step: 'bootstrap', action: 'DEFER', reason: 'deferred' },
      { step: 'brief', action: 'RUN', reason: 'needed' },
    ];

    assert.doesNotThrow(
      () => validatePlan(plan),
      'validatePlan should pass silently for RUN/DEFER-only plan'
    );
  });

  it('should not throw for an empty plan', () => {
    const { validatePlan } = require('../plan-generator');

    assert.doesNotThrow(
      () => validatePlan([]),
      'validatePlan should pass silently for empty plan'
    );
  });

  it('should throw with descriptive error including step name for SKIP entries', () => {
    const { validatePlan } = require('../plan-generator');

    const plan = [
      { step: 'implement', action: 'SKIP', reason: 'skipped' },
    ];

    assert.throws(
      () => validatePlan(plan),
      (err) => {
        assert.ok(err.message.includes('implement'), 'Error should include step name');
        return true;
      }
    );
  });
});
