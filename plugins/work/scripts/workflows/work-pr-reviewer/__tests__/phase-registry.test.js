'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getPhase, hasPhase } = require('../lib/phase-registry');
const { PR_REVIEW_PHASE_ORDER } = require('../pr-review-phase-registry');

test('dispatcher registers every declared phase', () => {
  for (const p of PR_REVIEW_PHASE_ORDER) assert.equal(hasPhase(p), true);
});

test('every phase exposes validate() and instructions()', () => {
  for (const p of PR_REVIEW_PHASE_ORDER) {
    const h = getPhase(p);
    assert.equal(typeof h.validate, 'function');
    assert.equal(typeof h.instructions, 'function');
  }
});

test('non-terminal phases have string `next`; done has null', () => {
  for (const p of PR_REVIEW_PHASE_ORDER) {
    const h = getPhase(p);
    if (p === 'done') assert.equal(h.next, null);
    else assert.equal(typeof h.next, 'string');
  }
});

test('getPhase throws on unknown name', () => {
  assert.throws(() => getPhase('made-up'), /No pr-review phase handler registered/);
});
