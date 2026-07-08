'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getPhase, hasPhase } = require('../lib/phase-registry');
const { COMPLETION_PHASE_ORDER } = require('../completion-phase-registry');

test('dispatcher registers every declared phase', () => {
  for (const p of COMPLETION_PHASE_ORDER) {
    assert.equal(hasPhase(p), true, `expected dispatcher to know phase "${p}"`);
  }
});

test('every registered phase exposes validate() and instructions()', () => {
  for (const p of COMPLETION_PHASE_ORDER) {
    const h = getPhase(p);
    assert.equal(typeof h.validate, 'function');
    assert.equal(typeof h.instructions, 'function');
  }
});

test('non-terminal phase handlers have a `next` string; done has next=null', () => {
  for (const p of COMPLETION_PHASE_ORDER) {
    const h = getPhase(p);
    if (p === 'done') assert.equal(h.next, null);
    else assert.equal(typeof h.next, 'string');
  }
});

test('getPhase throws on unknown name', () => {
  assert.throws(() => getPhase('made-up'), /No completion phase handler registered/);
});
