'use strict';

/**
 * Structural smoke test: `dispatchStepResult` is exported from step-registry
 * (alongside runStep / STEPS / registerStep) and follows the documented
 * surface/blocked/null decision table.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { dispatchStepResult } = require('../lib/step-registry');

describe('lib/step-registry — dispatchStepResult smoke', () => {
  it('is exported as a function', () => {
    assert.equal(typeof dispatchStepResult, 'function');
  });

  it('action=surface → terminate=true, instruction echoed', () => {
    const result = { action: 'surface', payload: { reason: 'infra-stuck' } };
    const d = dispatchStepResult({}, result);
    assert.equal(d.terminate, true);
    assert.deepEqual(d.instruction, result);
  });

  it('action=blocked → terminate=true', () => {
    const result = { action: 'blocked', reason: 'something' };
    const d = dispatchStepResult({}, result);
    assert.equal(d.terminate, true);
    assert.deepEqual(d.instruction, result);
  });

  it('null result → terminate=false', () => {
    const d = dispatchStepResult({}, null);
    assert.equal(d.terminate, false);
    assert.equal(d.instruction, null);
  });

  it('action=execute → terminate=false (loop continues, instruction echoed)', () => {
    const result = { action: 'execute', delegate: { type: 'bash', command: 'echo hi' } };
    const d = dispatchStepResult({}, result);
    assert.equal(d.terminate, false);
    assert.deepEqual(d.instruction, result);
  });
});
