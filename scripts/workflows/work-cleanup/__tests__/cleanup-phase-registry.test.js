'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLEANUP_PHASES,
  CLEANUP_PHASE_ORDER,
  CLEANUP_PHASE_TRANSITIONS,
  CLEANUP_INITIAL_PHASE,
  CLEANUP_TERMINAL_PHASE,
  cleanupNextPhases,
  cleanupCanTransition,
  isCleanupPhase,
} = require('../cleanup-phase-registry');

test('CLEANUP_PHASE_ORDER lists 7 phases in declared order', () => {
  assert.deepEqual(CLEANUP_PHASE_ORDER, [
    'inputs',
    'pr_merged_check',
    'branch_cleanup',
    'tmux_cleanup',
    'state_archive',
    'memorize',
    'done',
  ]);
});

test('initial is inputs, terminal is done', () => {
  assert.equal(CLEANUP_INITIAL_PHASE, 'inputs');
  assert.equal(CLEANUP_TERMINAL_PHASE, 'done');
});

test('every non-terminal phase advances to the next', () => {
  for (let i = 0; i < CLEANUP_PHASE_ORDER.length - 1; i++) {
    const cur = CLEANUP_PHASE_ORDER[i];
    const nxt = CLEANUP_PHASE_ORDER[i + 1];
    assert.ok(cleanupCanTransition(cur, nxt));
    assert.deepEqual(cleanupNextPhases(cur), [nxt]);
  }
});

test('done is terminal', () => {
  assert.deepEqual(CLEANUP_PHASE_TRANSITIONS.done, []);
});

test('rejects backwards transitions', () => {
  assert.equal(cleanupCanTransition('tmux_cleanup', 'inputs'), false);
  assert.equal(cleanupCanTransition('done', 'memorize'), false);
});

test('isCleanupPhase recognizes valid phases', () => {
  for (const p of CLEANUP_PHASE_ORDER) assert.equal(isCleanupPhase(p), true);
  assert.equal(isCleanupPhase('made-up'), false);
});

test('CLEANUP_PHASES is frozen', () => {
  assert.throws(() => {
    CLEANUP_PHASES.bogus = 'x';
  });
});
