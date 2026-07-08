'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractField, parseSuggestedScope } = require('../task-next.js');

test('extractField ignores in-prose backticked heading mentions', () => {
  const section = [
    '## Task 2',
    '',
    '### Acceptance Criteria',
    '- 2.1.2 GREEN mirror the BACKTICK### Files in scopeBACKTICK heading regex',
    '- 2.1.3 REFACTOR',
    '',
    '### Files in scope',
    '- BACKTICKplugins/work/lib/foo.jsBACKTICK',
    '- BACKTICKplugins/work/__tests__/foo.test.jsBACKTICK (NEW)',
    '',
    '### Test Command',
    '',
  ]
    .join('\n')
    .replace(/BACKTICK/g, String.fromCharCode(96));
  const scope = parseSuggestedScope(section);
  assert.deepEqual(scope, ['plugins/work/lib/foo.js', 'plugins/work/__tests__/foo.test.js']);
});

test('extractField matches a heading at start-of-string', () => {
  const section = '### Files in scope\n- BACKTICKfoo/bar.jsBACKTICK\n\n### Test Command\n'.replace(
    /BACKTICK/g,
    String.fromCharCode(96)
  );
  assert.equal(extractField(section, 'Files in scope').trim().includes('foo/bar.js'), true);
});

test('extractField does NOT match heading-like substring without leading newline', () => {
  const section = 'prefix BACKTICK### Files in scopeBACKTICK inline\n### Other\n'.replace(
    /BACKTICK/g,
    String.fromCharCode(96)
  );
  assert.equal(extractField(section, 'Files in scope'), '');
});

test('parseSuggestedScope: when BOTH headings are present, `Files in scope` wins (canonical per spec Open Q #3)', () => {
  const section = [
    '## Task 7',
    '',
    '### Suggested Scope',
    '- BACKTICKlegacy/old-path.jsBACKTICK',
    '- BACKTICKlegacy/other.jsBACKTICK',
    '',
    '### Files in scope',
    '- BACKTICKcanonical/new-path.jsBACKTICK',
    '- BACKTICKcanonical/new-test.test.jsBACKTICK',
    '',
    '### Test Command',
    '',
  ]
    .join('\n')
    .replace(/BACKTICK/g, String.fromCharCode(96));
  const scope = parseSuggestedScope(section);
  assert.deepEqual(
    scope,
    ['canonical/new-path.js', 'canonical/new-test.test.js'],
    '`Files in scope` is the canonical heading and must override `Suggested Scope` when both are present'
  );
});
