'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PR_REVIEW_PHASES,
  PR_REVIEW_PHASE_ORDER,
  PR_REVIEW_PHASE_TRANSITIONS,
  PR_REVIEW_INITIAL_PHASE,
  PR_REVIEW_TERMINAL_PHASE,
  prReviewNextPhases,
  prReviewCanTransition,
  isPrReviewPhase,
} = require('../pr-review-phase-registry');

test('PR_REVIEW_PHASE_ORDER lists 8 phases in declared order', () => {
  assert.deepEqual(PR_REVIEW_PHASE_ORDER, [
    'inputs',
    'pr_context',
    'diff_audit',
    'standards_audit',
    'kind_checks',
    'review_post',
    'memorize',
    'done',
  ]);
});

test('initial is inputs, terminal is done', () => {
  assert.equal(PR_REVIEW_INITIAL_PHASE, 'inputs');
  assert.equal(PR_REVIEW_TERMINAL_PHASE, 'done');
});

test('every non-terminal phase advances to the next', () => {
  for (let i = 0; i < PR_REVIEW_PHASE_ORDER.length - 1; i++) {
    const cur = PR_REVIEW_PHASE_ORDER[i];
    const nxt = PR_REVIEW_PHASE_ORDER[i + 1];
    assert.ok(prReviewCanTransition(cur, nxt));
    assert.deepEqual(prReviewNextPhases(cur), [nxt]);
  }
});

test('done is terminal', () => {
  assert.deepEqual(PR_REVIEW_PHASE_TRANSITIONS.done, []);
});

test('rejects backwards', () => {
  assert.equal(prReviewCanTransition('kind_checks', 'inputs'), false);
});

test('isPrReviewPhase recognizes valid phases', () => {
  for (const p of PR_REVIEW_PHASE_ORDER) assert.equal(isPrReviewPhase(p), true);
  assert.equal(isPrReviewPhase('made-up'), false);
});

test('PR_REVIEW_PHASES frozen', () => {
  assert.throws(() => {
    PR_REVIEW_PHASES.bogus = 'x';
  });
});
