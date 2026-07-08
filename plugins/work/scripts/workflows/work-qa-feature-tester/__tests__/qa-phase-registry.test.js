'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  QA_PHASES,
  QA_PHASE_ORDER,
  QA_PHASE_TRANSITIONS,
  QA_INITIAL_PHASE,
  QA_TERMINAL_PHASE,
  qaNextPhases,
  qaCanTransition,
  isQaPhase,
} = require('../qa-phase-registry');

test('QA_PHASE_ORDER lists 9 phases in declared order', () => {
  assert.deepEqual(QA_PHASE_ORDER, [
    'inputs',
    'env_setup',
    'smoke',
    'feature',
    'kind_checks',
    'screenshot',
    'report',
    'memorize',
    'done',
  ]);
});

test('initial is inputs, terminal is done', () => {
  assert.equal(QA_INITIAL_PHASE, 'inputs');
  assert.equal(QA_TERMINAL_PHASE, 'done');
});

test('every non-terminal phase advances to the next in order', () => {
  for (let i = 0; i < QA_PHASE_ORDER.length - 1; i++) {
    const cur = QA_PHASE_ORDER[i];
    const nxt = QA_PHASE_ORDER[i + 1];
    assert.ok(qaCanTransition(cur, nxt));
    assert.deepEqual(qaNextPhases(cur), [nxt]);
  }
});

test('done is terminal', () => {
  assert.deepEqual(QA_PHASE_TRANSITIONS.done, []);
});

test('rejects backwards/skipping', () => {
  assert.equal(qaCanTransition('feature', 'inputs'), false);
  assert.equal(qaCanTransition('inputs', 'feature'), false);
});

test('isQaPhase recognizes valid phases', () => {
  for (const p of QA_PHASE_ORDER) assert.equal(isQaPhase(p), true);
  assert.equal(isQaPhase('made-up'), false);
});

test('QA_PHASES frozen', () => {
  assert.throws(() => {
    QA_PHASES.bogus = 'x';
  });
});
