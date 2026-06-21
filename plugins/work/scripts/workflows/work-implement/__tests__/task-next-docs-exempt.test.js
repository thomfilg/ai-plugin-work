// Docs-exempt RED gate: documentation tasks have no testable code surface,
// so they validate RED via their verification command instead of requiring a
// *.test.* authorship file. See task-next.js `isDocsExempt()`.
//
// GH-528: the body-prose regex branch was removed. Detection is now
// `### Type === 'docs'` ONLY — the planner authors Type and it is
// scope-protected at implement time, so the implementer agent cannot flip
// the gate by inserting "docs-only" / "documentation exempt" phrases.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isDocsExempt } = require('../task-next.js');

test('isDocsExempt: true for explicit `docs` type', () => {
  assert.equal(isDocsExempt('docs'), true);
});

test('GH-528: body prose "documentation exempt" NO LONGER flips the gate', () => {
  const section = '### Type\nfullstack\n\nDocs-only (no R/G/R — documentation exempt)';
  assert.equal(isDocsExempt('fullstack', section), false);
});

test('GH-528: body prose "docs-only" NO LONGER flips the gate', () => {
  assert.equal(isDocsExempt('backend', 'Docs-only task, prose only'), false);
});

test('isDocsExempt: false for a normal code task', () => {
  assert.equal(isDocsExempt('backend', '### Type\nbackend\n\nImplement the resolver'), false);
});

test('isDocsExempt: tolerates missing/empty inputs', () => {
  assert.equal(isDocsExempt('', ''), false);
  assert.equal(isDocsExempt(undefined, undefined), false);
});
