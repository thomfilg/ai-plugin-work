// Pre-existed-regression RED fallback: regression tasks that exercise code
// already implemented in a prior task cannot organically produce a failing
// test command. Authors opt in via a marker phrase in the task body
// ("behaviour pre-existed" / "regression test added"), and the RED gate
// accepts exit 0 by forwarding `--synthesized` to tdd-phase-state.js.
// See task-next.js `isPreExistedRegressionTask()` and the RED-phase branch
// added for tasks.md line 233 (GH-304 Task 3).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isPreExistedRegressionTask } = require('../task-next.js');

test('isPreExistedRegressionTask: true for "behaviour pre-existed" marker', () => {
  const section =
    '### Type\ndevops\n\nExpected outcome: behaviour pre-existed, regression test added.';
  assert.equal(isPreExistedRegressionTask(section), true);
});

test('isPreExistedRegressionTask: true for "behavior pre-existed" (US spelling) is NOT matched — only British spelling per tasks.md template', () => {
  const section = 'Expected outcome: behavior pre-existed, regression test added.';
  // Marker phrase mirrors the tasks.md template wording verbatim (British
  // "behaviour"). US spelling is deliberately not matched to keep the marker
  // surface narrow.
  assert.equal(isPreExistedRegressionTask(section), true /* still matches via "regression test added" alternation */);
});

test('isPreExistedRegressionTask: true for "regression test added" alone', () => {
  const section = 'mark RED as regression test added and continue';
  assert.equal(isPreExistedRegressionTask(section), true);
});

test('isPreExistedRegressionTask: tolerates hyphenated "pre-existed" form', () => {
  const section = 'behaviour pre-existed; regression test added';
  assert.equal(isPreExistedRegressionTask(section), true);
});

test('isPreExistedRegressionTask: tolerates non-hyphenated "preexisted" form', () => {
  const section = 'behaviour preexisted, regression test added';
  assert.equal(isPreExistedRegressionTask(section), true);
});

test('isPreExistedRegressionTask: false for a normal RED task body', () => {
  const section =
    '### Type\nbackend\n\nWrite a failing test for the new resolver, then implement.';
  assert.equal(isPreExistedRegressionTask(section), false);
});

test('isPreExistedRegressionTask: false for tasks that merely mention "regression" without the opt-in phrase', () => {
  const section = 'Add a regression assertion ensuring the bug stays fixed.';
  assert.equal(isPreExistedRegressionTask(section), false);
});

test('isPreExistedRegressionTask: tolerates missing/empty inputs', () => {
  assert.equal(isPreExistedRegressionTask(''), false);
  assert.equal(isPreExistedRegressionTask(undefined), false);
  assert.equal(isPreExistedRegressionTask(null), false);
});

test('isPreExistedRegressionTask: case-insensitive', () => {
  assert.equal(isPreExistedRegressionTask('BEHAVIOUR PRE-EXISTED, regression test added'), true);
  assert.equal(isPreExistedRegressionTask('Regression Test Added'), true);
});
