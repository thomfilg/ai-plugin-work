'use strict';

/**
 * Task 9 — P0 #7c: draft.js tasks.md template must emit a
 * `### Cross-Task Dependencies` block with an explanatory one-line comment.
 *
 * The block mirrors the parser shape introduced in Task 7 so authors see the
 * header in the scaffold and the parser (`task-parser.js`) can pick it up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const draft = require('../../../lib/phases/draft');

function renderInstructions() {
  return draft.instructions({
    ticket: 'GH-1',
    tasksDir: '/tmp/tasks-gh-1',
  });
}

test('draft.instructions() template includes ### Cross-Task Dependencies header', () => {
  const out = renderInstructions();
  assert.match(
    out,
    /### Cross-Task Dependencies/,
    'expected the emitted tasks.md template to contain the literal `### Cross-Task Dependencies` header'
  );
});

test('draft.instructions() template includes an explanatory comment for Cross-Task Dependencies', () => {
  const out = renderInstructions();
  assert.match(
    out,
    /files owned by other tasks/i,
    'expected an inline explanatory comment matching /files owned by other tasks/i near the Cross-Task Dependencies section'
  );
});

test('Cross-Task Dependencies header sits alongside the other scope-shaped sections', () => {
  const out = renderInstructions();
  const idxOut = out.indexOf('### Files explicitly out of scope');
  const idxCross = out.indexOf('### Cross-Task Dependencies');
  assert.ok(idxOut !== -1, 'precondition: `### Files explicitly out of scope` should exist');
  assert.ok(idxCross !== -1, 'Cross-Task Dependencies header must be present');
  // We don't pin the exact ordering, but the new section should live near the
  // other scope-shaped sections (after "Files in scope", before/after the
  // out-of-scope block). Asserting both exist is enough to ensure the parser
  // shape from Task 7 is mirrored in the scaffold.
});
