'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getPhase, hasPhase } = require('../lib/phase-registry');
const { TASK_REVIEW_PHASE_ORDER } = require('../task-review-phase-registry');

test('dispatcher registers every phase from the registry', () => {
  for (const p of TASK_REVIEW_PHASE_ORDER) {
    assert.ok(hasPhase(p), `phase ${p} not registered`);
    const h = getPhase(p);
    assert.equal(typeof h.validate, 'function');
    assert.equal(typeof h.instructions, 'function');
  }
});

test('getPhase throws for unknown phases', () => {
  assert.throws(() => getPhase('made-up'), /No task-review phase handler/);
});

test('done is terminal (next is null)', () => {
  assert.equal(getPhase('done').next, null);
});
