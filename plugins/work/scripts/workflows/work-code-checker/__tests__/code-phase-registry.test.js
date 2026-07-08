'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CODE_PHASES,
  CODE_PHASE_ORDER,
  CODE_PHASE_TRANSITIONS,
  CODE_INITIAL_PHASE,
  CODE_TERMINAL_PHASE,
  codeNextPhases,
  codeCanTransition,
  isCodePhase,
} = require('../code-phase-registry');

test('CODE_PHASE_ORDER lists 8 phases in declared order', () => {
  assert.deepEqual(CODE_PHASE_ORDER, [
    'inputs',
    'change_classify',
    'file_coverage',
    'standards_audit',
    'kind_checks',
    'report',
    'memorize',
    'done',
  ]);
});

test('initial is inputs, terminal is done', () => {
  assert.equal(CODE_INITIAL_PHASE, 'inputs');
  assert.equal(CODE_TERMINAL_PHASE, 'done');
});

test('every non-terminal phase advances to the next in order', () => {
  for (let i = 0; i < CODE_PHASE_ORDER.length - 1; i++) {
    const cur = CODE_PHASE_ORDER[i];
    const nxt = CODE_PHASE_ORDER[i + 1];
    assert.ok(codeCanTransition(cur, nxt));
    assert.deepEqual(codeNextPhases(cur), [nxt]);
  }
});

test('done is terminal', () => {
  assert.deepEqual(CODE_PHASE_TRANSITIONS.done, []);
});

test('codeCanTransition rejects backwards/skipping', () => {
  assert.equal(codeCanTransition('report', 'inputs'), false);
  assert.equal(codeCanTransition('inputs', 'report'), false);
});

test('isCodePhase recognizes valid phases', () => {
  for (const p of CODE_PHASE_ORDER) assert.equal(isCodePhase(p), true);
  assert.equal(isCodePhase('made-up'), false);
});

test('CODE_PHASES frozen', () => {
  assert.throws(() => {
    CODE_PHASES.bogus = 'x';
  });
});
