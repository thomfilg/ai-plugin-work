// Docs-exempt RED gate: documentation tasks have no testable code surface,
// so they validate RED via their verification command instead of requiring a
// *.test.* authorship file. See task-next.js `isDocsExempt()`.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isDocsExempt } = require('../task-next.js');

test('isDocsExempt: true for explicit `docs` type', () => {
  assert.equal(isDocsExempt('docs', '### Type\ndocs\n\nwhatever'), true);
});

test('isDocsExempt: true for "documentation exempt" marker in body', () => {
  const section = '### Type\nfullstack\n\nDocs-only (no R/G/R — documentation exempt)';
  assert.equal(isDocsExempt('fullstack', section), true);
});

test('isDocsExempt: true for "docs-only" marker regardless of type', () => {
  assert.equal(isDocsExempt('backend', 'Docs-only task, prose only'), true);
});

test('isDocsExempt: false for a normal code task', () => {
  assert.equal(isDocsExempt('backend', '### Type\nbackend\n\nImplement the resolver'), false);
});

test('isDocsExempt: tolerates missing/empty inputs', () => {
  assert.equal(isDocsExempt('', ''), false);
  assert.equal(isDocsExempt(undefined, undefined), false);
});
