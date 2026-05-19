'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TASKS_PHASES,
  TASKS_PHASE_ORDER,
  TASKS_PHASE_TRANSITIONS,
  TASKS_INITIAL_PHASE,
  TASKS_TERMINAL_PHASE,
  tasksNextPhases,
  tasksCanTransition,
  isTasksPhase,
} = require('../tasks-phase-registry');
const { getPhase, hasPhase } = require('../lib/phase-registry');

test('TASKS_PHASE_ORDER is 8 phases in declared order', () => {
  assert.deepEqual(TASKS_PHASE_ORDER, [
    'inputs',
    'requirements_extract',
    'draft',
    'traceability',
    'kind_assign',
    'gherkin_link',
    'memorize',
    'done',
  ]);
});

test('initial = inputs, terminal = done', () => {
  assert.equal(TASKS_INITIAL_PHASE, 'inputs');
  assert.equal(TASKS_TERMINAL_PHASE, 'done');
});

test('every non-terminal phase transitions to exactly the next', () => {
  for (let i = 0; i < TASKS_PHASE_ORDER.length - 1; i++) {
    const cur = TASKS_PHASE_ORDER[i];
    const nxt = TASKS_PHASE_ORDER[i + 1];
    assert.ok(tasksCanTransition(cur, nxt), `${cur} → ${nxt} should be allowed`);
    assert.deepEqual(tasksNextPhases(cur), [nxt]);
  }
});

test('done is terminal', () => {
  assert.deepEqual(TASKS_PHASE_TRANSITIONS.done, []);
});

test('tasksCanTransition rejects backwards / skipping', () => {
  assert.equal(tasksCanTransition('draft', 'inputs'), false);
  assert.equal(tasksCanTransition('inputs', 'draft'), false);
});

test('isTasksPhase recognizes valid and rejects unknowns', () => {
  for (const p of TASKS_PHASE_ORDER) assert.equal(isTasksPhase(p), true);
  assert.equal(isTasksPhase('madeup'), false);
});

test('dispatcher registers every phase with validate + instructions', () => {
  for (const p of TASKS_PHASE_ORDER) {
    assert.equal(hasPhase(p), true);
    const h = getPhase(p);
    assert.equal(typeof h.validate, 'function');
    assert.equal(typeof h.instructions, 'function');
  }
});

test('done has next=null, others have a next string', () => {
  for (const p of TASKS_PHASE_ORDER) {
    const h = getPhase(p);
    if (p === 'done') assert.equal(h.next, null);
    else assert.equal(typeof h.next, 'string');
  }
});

test('TASKS_PHASES is frozen', () => {
  assert.throws(() => {
    TASKS_PHASES.bogus = 'x';
  });
});
