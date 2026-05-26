'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PR_PHASES,
  PR_PHASE_ORDER,
  PR_PHASE_TRANSITIONS,
  prCanTransition,
  prNextPhases,
  isPrPhase,
} = require('../pr-phase-registry');
const { getPhase, hasPhase } = require('../lib/phase-registry');

test('PR_PHASE_ORDER is 8 phases in declared order', () => {
  assert.deepEqual(PR_PHASE_ORDER, [
    'inputs',
    'diff_audit',
    'description_draft',
    'validate_description',
    'create_or_update',
    'attachments',
    'memorize',
    'done',
  ]);
});

test('every non-terminal phase transitions to the next', () => {
  for (let i = 0; i < PR_PHASE_ORDER.length - 1; i++) {
    assert.ok(prCanTransition(PR_PHASE_ORDER[i], PR_PHASE_ORDER[i + 1]));
  }
});

test('done is terminal', () => {
  assert.deepEqual(PR_PHASE_TRANSITIONS.done, []);
  assert.deepEqual(prNextPhases('done'), []);
});

test('isPrPhase recognizes valid and rejects unknowns', () => {
  for (const p of PR_PHASE_ORDER) assert.equal(isPrPhase(p), true);
  assert.equal(isPrPhase('madeup'), false);
});

test('dispatcher registers every phase with validate + instructions', () => {
  for (const p of PR_PHASE_ORDER) {
    assert.equal(hasPhase(p), true);
    const h = getPhase(p);
    assert.equal(typeof h.validate, 'function');
    assert.equal(typeof h.instructions, 'function');
  }
});

test('PR_PHASES frozen', () => {
  assert.throws(() => {
    PR_PHASES.bogus = 'x';
  });
});
