'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TASK_REVIEW_PHASES,
  TASK_REVIEW_PHASE_ORDER,
  TASK_REVIEW_PHASE_TRANSITIONS,
  TASK_REVIEW_INITIAL_PHASE,
  TASK_REVIEW_TERMINAL_PHASE,
  taskReviewNextPhases,
  taskReviewCanTransition,
  isTaskReviewPhase,
} = require('../task-review-phase-registry');

test('TASK_REVIEW_PHASE_ORDER lists 8 phases in declared order', () => {
  assert.deepEqual(TASK_REVIEW_PHASE_ORDER, [
    'inputs',
    'diff_audit',
    'reuse_check',
    'kind_checks',
    'coverage',
    'report',
    'memorize',
    'done',
  ]);
});

test('initial is inputs, terminal is done', () => {
  assert.equal(TASK_REVIEW_INITIAL_PHASE, 'inputs');
  assert.equal(TASK_REVIEW_TERMINAL_PHASE, 'done');
});

test('every non-terminal phase advances to the next', () => {
  for (let i = 0; i < TASK_REVIEW_PHASE_ORDER.length - 1; i++) {
    const cur = TASK_REVIEW_PHASE_ORDER[i];
    const nxt = TASK_REVIEW_PHASE_ORDER[i + 1];
    assert.ok(taskReviewCanTransition(cur, nxt));
    assert.deepEqual(taskReviewNextPhases(cur), [nxt]);
  }
});

test('done is terminal', () => {
  assert.deepEqual(TASK_REVIEW_PHASE_TRANSITIONS.done, []);
});

test('rejects backwards transitions', () => {
  assert.equal(taskReviewCanTransition('kind_checks', 'inputs'), false);
  assert.equal(taskReviewCanTransition('done', 'memorize'), false);
});

test('isTaskReviewPhase recognizes valid phases', () => {
  for (const p of TASK_REVIEW_PHASE_ORDER) assert.equal(isTaskReviewPhase(p), true);
  assert.equal(isTaskReviewPhase('made-up'), false);
});

test('TASK_REVIEW_PHASES is frozen', () => {
  assert.throws(() => {
    TASK_REVIEW_PHASES.bogus = 'x';
  });
});
