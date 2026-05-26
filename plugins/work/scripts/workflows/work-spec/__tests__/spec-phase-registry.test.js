'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SPEC_PHASES,
  SPEC_PHASE_ORDER,
  SPEC_PHASE_TRANSITIONS,
  SPEC_INITIAL_PHASE,
  SPEC_TERMINAL_PHASE,
  specNextPhases,
  specCanTransition,
  isSpecPhase,
} = require('../spec-phase-registry');

test('SPEC_PHASE_ORDER lists 8 phases in declared order', () => {
  assert.deepEqual(SPEC_PHASE_ORDER, [
    'inputs',
    'reuse_audit',
    'surface_audit',
    'draft',
    'validate',
    'memorize',
    'kind_checks',
    'done',
  ]);
});

test('initial phase is inputs, terminal is done', () => {
  assert.equal(SPEC_INITIAL_PHASE, 'inputs');
  assert.equal(SPEC_TERMINAL_PHASE, 'done');
});

test('every non-terminal phase transitions to exactly the next one in order', () => {
  for (let i = 0; i < SPEC_PHASE_ORDER.length - 1; i++) {
    const cur = SPEC_PHASE_ORDER[i];
    const nxt = SPEC_PHASE_ORDER[i + 1];
    assert.ok(specCanTransition(cur, nxt), `expected ${cur} → ${nxt} to be allowed`);
    assert.deepEqual(specNextPhases(cur), [nxt]);
  }
});

test('done is terminal (no outgoing edges)', () => {
  assert.deepEqual(SPEC_PHASE_TRANSITIONS.done, []);
  assert.equal(specNextPhases('done').length, 0);
});

test('specCanTransition rejects backwards and skipping transitions', () => {
  assert.equal(specCanTransition('draft', 'inputs'), false);
  assert.equal(specCanTransition('inputs', 'draft'), false);
  assert.equal(specCanTransition('surface_audit', 'memorize'), false);
});

test('isSpecPhase recognizes valid phases and rejects unknowns', () => {
  for (const p of SPEC_PHASE_ORDER) assert.equal(isSpecPhase(p), true);
  assert.equal(isSpecPhase('made-up-phase'), false);
  assert.equal(isSpecPhase(''), false);
});

test('SPEC_PHASES frozen — cannot be mutated', () => {
  assert.throws(() => {
    SPEC_PHASES.bogus = 'bogus';
  });
});
