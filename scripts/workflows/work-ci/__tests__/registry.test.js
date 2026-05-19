'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CI_PHASES,
  CI_PHASE_ORDER,
  CI_PHASE_TRANSITIONS,
  ciCanTransition,
  ciNextPhases,
  isCiPhase,
} = require('../ci-phase-registry');
const { getPhase, hasPhase } = require('../lib/phase-registry');

test('CI_PHASE_ORDER is 7 phases in declared order', () => {
  assert.deepEqual(CI_PHASE_ORDER, [
    'inputs',
    'wait',
    'triage',
    'fix_or_document',
    'rerun_check',
    'memorize',
    'done',
  ]);
});

test('every non-terminal phase transitions to next', () => {
  for (let i = 0; i < CI_PHASE_ORDER.length - 1; i++) {
    assert.ok(ciCanTransition(CI_PHASE_ORDER[i], CI_PHASE_ORDER[i + 1]));
  }
});

test('done is terminal', () => {
  assert.deepEqual(CI_PHASE_TRANSITIONS.done, []);
  assert.deepEqual(ciNextPhases('done'), []);
});

test('isCiPhase recognizes valid and rejects unknowns', () => {
  for (const p of CI_PHASE_ORDER) assert.equal(isCiPhase(p), true);
  assert.equal(isCiPhase('madeup'), false);
});

test('dispatcher registers every phase with validate + instructions', () => {
  for (const p of CI_PHASE_ORDER) {
    assert.equal(hasPhase(p), true);
    const h = getPhase(p);
    assert.equal(typeof h.validate, 'function');
    assert.equal(typeof h.instructions, 'function');
  }
});

test('CI_PHASES frozen', () => {
  assert.throws(() => {
    CI_PHASES.bogus = 'x';
  });
});
