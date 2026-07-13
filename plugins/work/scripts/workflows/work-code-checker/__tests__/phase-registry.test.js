'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getPhase, hasPhase } = require('../lib/phase-registry');
const { CODE_PHASE_ORDER } = require('../code-phase-registry');

test('dispatcher registers every declared phase', () => {
  for (const p of CODE_PHASE_ORDER) {
    assert.equal(hasPhase(p), true, `expected dispatcher to know "${p}"`);
  }
});

test('every phase exposes validate() and instructions()', () => {
  for (const p of CODE_PHASE_ORDER) {
    const h = getPhase(p);
    assert.equal(typeof h.validate, 'function');
    assert.equal(typeof h.instructions, 'function');
  }
});

test('non-terminal phases have string `next`; done has null', () => {
  for (const p of CODE_PHASE_ORDER) {
    const h = getPhase(p);
    if (p === 'done') assert.equal(h.next, null);
    else assert.equal(typeof h.next, 'string');
  }
});

test('getPhase throws on unknown name', () => {
  assert.throws(() => getPhase('made-up'), /No code phase handler registered/);
});
