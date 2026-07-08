'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COMPLETION_PHASES,
  COMPLETION_PHASE_ORDER,
  COMPLETION_PHASE_TRANSITIONS,
  COMPLETION_INITIAL_PHASE,
  COMPLETION_TERMINAL_PHASE,
  completionNextPhases,
  completionCanTransition,
  isCompletionPhase,
} = require('../completion-phase-registry');

test('COMPLETION_PHASE_ORDER lists 11 phases in declared order', () => {
  assert.deepEqual(COMPLETION_PHASE_ORDER, [
    'inputs',
    'requirements_extract',
    'diff_scope',
    'coverage_check',
    'reuse_audit_enforcement',
    'suggested_scope_enforcement',
    'test_pass_crossref',
    'kind_checks',
    'report',
    'memorize',
    'done',
  ]);
});

test('initial phase is inputs, terminal is done', () => {
  assert.equal(COMPLETION_INITIAL_PHASE, 'inputs');
  assert.equal(COMPLETION_TERMINAL_PHASE, 'done');
});

test('every non-terminal phase transitions to exactly the next one in order', () => {
  for (let i = 0; i < COMPLETION_PHASE_ORDER.length - 1; i++) {
    const cur = COMPLETION_PHASE_ORDER[i];
    const nxt = COMPLETION_PHASE_ORDER[i + 1];
    assert.ok(completionCanTransition(cur, nxt), `expected ${cur} → ${nxt} to be allowed`);
    assert.deepEqual(completionNextPhases(cur), [nxt]);
  }
});

test('done is terminal (no outgoing edges)', () => {
  assert.deepEqual(COMPLETION_PHASE_TRANSITIONS.done, []);
  assert.equal(completionNextPhases('done').length, 0);
});

test('completionCanTransition rejects backwards and skipping transitions', () => {
  assert.equal(completionCanTransition('diff_scope', 'inputs'), false);
  assert.equal(completionCanTransition('inputs', 'diff_scope'), false);
  assert.equal(completionCanTransition('coverage_check', 'memorize'), false);
});

test('isCompletionPhase recognizes valid phases and rejects unknowns', () => {
  for (const p of COMPLETION_PHASE_ORDER) assert.equal(isCompletionPhase(p), true);
  assert.equal(isCompletionPhase('made-up-phase'), false);
  assert.equal(isCompletionPhase(''), false);
});

test('COMPLETION_PHASES frozen — cannot be mutated', () => {
  assert.throws(() => {
    COMPLETION_PHASES.bogus = 'bogus';
  });
});
