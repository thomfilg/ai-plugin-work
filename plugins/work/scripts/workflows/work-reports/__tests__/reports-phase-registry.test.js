'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REPORTS_PHASES,
  REPORTS_PHASE_ORDER,
  REPORTS_PHASE_TRANSITIONS,
  REPORTS_INITIAL_PHASE,
  REPORTS_TERMINAL_PHASE,
  reportsNextPhases,
  reportsCanTransition,
  isReportsPhase,
} = require('../reports-phase-registry');

test('REPORTS_PHASE_ORDER lists 6 phases in declared order', () => {
  assert.deepEqual(REPORTS_PHASE_ORDER, [
    'inputs',
    'collect_artifacts',
    'summarize',
    'emit',
    'memorize',
    'done',
  ]);
});

test('initial is inputs, terminal is done', () => {
  assert.equal(REPORTS_INITIAL_PHASE, 'inputs');
  assert.equal(REPORTS_TERMINAL_PHASE, 'done');
});

test('every non-terminal phase advances to the next', () => {
  for (let i = 0; i < REPORTS_PHASE_ORDER.length - 1; i++) {
    const cur = REPORTS_PHASE_ORDER[i];
    const nxt = REPORTS_PHASE_ORDER[i + 1];
    assert.ok(reportsCanTransition(cur, nxt));
    assert.deepEqual(reportsNextPhases(cur), [nxt]);
  }
});

test('done is terminal', () => {
  assert.deepEqual(REPORTS_PHASE_TRANSITIONS.done, []);
});

test('rejects backwards transitions', () => {
  assert.equal(reportsCanTransition('summarize', 'inputs'), false);
  assert.equal(reportsCanTransition('done', 'memorize'), false);
});

test('isReportsPhase recognizes valid phases', () => {
  for (const p of REPORTS_PHASE_ORDER) assert.equal(isReportsPhase(p), true);
  assert.equal(isReportsPhase('made-up'), false);
});

test('REPORTS_PHASES is frozen', () => {
  assert.throws(() => {
    REPORTS_PHASES.bogus = 'x';
  });
});
