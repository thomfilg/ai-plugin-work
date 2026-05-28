// Visual-only RED gate: Storybook stories are visual artifacts with no
// executable assertions. When a task's `### Files in scope` contains only
// `.stories.[jt]sx?` files, the gate validates RED via the verification
// command (e.g. `pnpm dev:check`) instead of requiring a `*.test.*` file.
// See task-next.js `isVisualOnlyTask()`.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isVisualOnlyTask } = require('../task-next.js');

test('isVisualOnlyTask: true for scope of a single .stories.tsx file', () => {
  assert.equal(
    isVisualOnlyTask([
      'components/content/recycle-bin-dialogs/recycle-bin-restore-destination-dialog.stories.tsx',
    ]),
    true
  );
});

test('isVisualOnlyTask: true for multiple .stories.* files (tsx + ts + jsx)', () => {
  assert.equal(
    isVisualOnlyTask(['a/foo.stories.tsx', 'b/bar.stories.ts', 'c/baz.stories.jsx']),
    true
  );
});

test('isVisualOnlyTask: false when scope mixes story + non-story files', () => {
  assert.equal(isVisualOnlyTask(['components/foo.stories.tsx', 'components/foo.tsx']), false);
});

test('isVisualOnlyTask: false for plain component file', () => {
  assert.equal(isVisualOnlyTask(['components/foo.tsx']), false);
});

test('isVisualOnlyTask: false for a `*.test.*` file', () => {
  assert.equal(isVisualOnlyTask(['components/foo.test.tsx']), false);
});

test('isVisualOnlyTask: false for empty / missing / wrong-shape scope', () => {
  assert.equal(isVisualOnlyTask([]), false);
  assert.equal(isVisualOnlyTask(undefined), false);
  assert.equal(isVisualOnlyTask(null), false);
  assert.equal(isVisualOnlyTask('components/foo.stories.tsx'), false);
});

test('isVisualOnlyTask: ignores non-string entries defensively', () => {
  assert.equal(isVisualOnlyTask(['a.stories.tsx', 42]), false);
});

test('isVisualOnlyTask: case-insensitive match on extension', () => {
  assert.equal(isVisualOnlyTask(['components/Foo.Stories.TSX']), true);
});
