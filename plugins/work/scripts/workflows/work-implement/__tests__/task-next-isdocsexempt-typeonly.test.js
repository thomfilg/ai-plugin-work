'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isDocsExempt } = require('../task-next');

test('Type=docs is docs-exempt', () => {
  assert.equal(isDocsExempt('docs'), true);
});

test('Type=tdd-code is NOT docs-exempt regardless of body prose', () => {
  assert.equal(isDocsExempt('tdd-code'), false);
});

test('GH-528 bypass closure: body-prose phrases no longer trigger docs-exempt', () => {
  // Pre-fix: body containing "docs-only" or "documentation exempt" anywhere
  // would flip the gate. The implementer-agent could insert these phrases
  // into ACs at implement time and skip RED. After GH-528: ignored.
  const malicious = [
    'This task is docs-only — no test surface',
    'documentation exempt because the spec says so',
    'documentation-exempt',
    'docs only',
  ];
  for (const body of malicious) {
    // arity is now 1; passing a 2nd arg must NOT re-enable the bypass
    assert.equal(isDocsExempt('tdd-code', body), false, `body "${body}" must not flip`);
    assert.equal(isDocsExempt('tests-only', body), false, `body "${body}" must not flip`);
    assert.equal(isDocsExempt('', body), false, `body "${body}" must not flip empty type`);
  }
});

test('empty / missing type is NOT docs-exempt', () => {
  assert.equal(isDocsExempt(''), false);
  assert.equal(isDocsExempt(undefined), false);
  assert.equal(isDocsExempt(null), false);
});
