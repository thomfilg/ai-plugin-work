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

test('pr_merged_check feeds branch_cleanup directly — it is the only gate before teardown', () => {
  // The completion_check phase between them is gone: cleanup runs post-merge,
  // where completion evidence cannot change the outcome and could only strand
  // a shipped ticket. A merged PR is what makes the teardown safe.
  assert.deepEqual(cleanupNextPhases('pr_merged_check'), ['branch_cleanup']);
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

// A run saved while `completion_check` was a real phase must still drain.
// Deleting the id outright would have stranded exactly the merged tickets
// removing that gate was meant to unblock — a blocking gate replaced by a
// different blocking gate.
test('retired completion_check is drainable but not on the forward path', () => {
  const { getPhase } = require('../lib/phase-registry');

  assert.ok(!CLEANUP_PHASE_ORDER.includes('completion_check'), 'not in the forward path');
  assert.ok(isCleanupPhase('completion_check'), 'id stays valid so persisted state reads');

  // Nothing routes INTO it any more.
  for (const phase of CLEANUP_PHASE_ORDER) {
    assert.ok(
      !cleanupNextPhases(phase).includes('completion_check'),
      `${phase} must not route into the retired phase`
    );
  }

  // …and the only way out of it is forward, without demanding any evidence.
  const handler = getPhase('completion_check');
  assert.equal(handler.next, 'branch_cleanup');
  assert.equal(handler.validate({}).ok, true);
  assert.deepEqual(cleanupNextPhases('completion_check'), ['branch_cleanup']);
});
