'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { levenshtein, findUnknownKeys, validateValues } = require('../validate');
const { mergeSchemas } = require('../schema');

const merged = mergeSchemas([
  {
    plugin: 'demo',
    prefixes: ['ENABLE_', 'DEMO_'],
    internal: ['DEMO_RUNTIME_ID'],
    vars: {
      ENABLE_DRAFT_PR: { type: 'bool01', default: '0', description: 'f', section: 'S' },
      DEMO_MODE: { type: 'enum', values: ['a', 'b'], default: 'a', description: 'm', section: 'S' },
      DEMO_PORT: { type: 'number', default: '', description: 'p', section: 'S' },
      DEMO_APPS: { type: 'json', default: '', description: 'j', section: 'S' },
      DEMO_FLAG2: { type: 'boolean', default: 'true', description: 'b', section: 'S' },
      DEMO_NAME: { type: 'string', default: '', description: 's', section: 'S' },
    },
  },
]);

function vals(pairs) {
  return Object.fromEntries(
    Object.entries(pairs).map(([k, v]) => [k, { value: v, dynamic: false, source: 'test' }])
  );
}

test('levenshtein distances', () => {
  assert.equal(levenshtein('ENABLE_X', 'ENABLE_X'), 0);
  assert.equal(levenshtein('ENABEL_DRAFT_PR', 'ENABLE_DRAFT_PR'), 2);
  assert.ok(levenshtein('COMPLETELY', 'DIFFERENT') > 2);
});

test('findUnknownKeys flags prefixed typos with a suggestion', () => {
  const unknown = findUnknownKeys(merged, ['ENABEL_DRAFT_PR', 'ENABLE_DRAFT_PR', 'UNRELATED']);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].name, 'ENABEL_DRAFT_PR');
  assert.equal(unknown[0].suggestion, 'ENABLE_DRAFT_PR');
});

test('findUnknownKeys ignores internal vars and unmatched prefixes', () => {
  assert.deepEqual(findUnknownKeys(merged, ['DEMO_RUNTIME_ID', 'PATH', 'HOME']), []);
  const noSuggestion = findUnknownKeys(merged, ['DEMO_ZZZZZZZZZ']);
  assert.equal(noSuggestion[0].suggestion, null);
});

test('findUnknownKeys skips the fuzzy path for process-env names', () => {
  const values = {
    // Typo'd prefix from the process env: NOT flagged (fuzzy is file-only).
    ENABEL_DRAFT_PR: { source: 'process' },
    // Near-miss of DEMO_MODE from the process env: NOT flagged either.
    NEMO_MODE: { source: 'process' },
    // Exact declared prefix from the process env: still flagged.
    ENABLE_TYPO_XYZ: { source: 'process' },
    // Near-miss written in a config file: flagged with a hint.
    DEMO_MODEE: { source: 'envrc' },
  };
  assert.deepEqual(findUnknownKeys(merged, values), [
    { name: 'ENABLE_TYPO_XYZ', suggestion: null },
    { name: 'DEMO_MODEE', suggestion: 'DEMO_MODE' },
  ]);
});

test('validateValues warns per declared type', () => {
  const warnings = validateValues(
    merged,
    vals({
      ENABLE_DRAFT_PR: 'yes',
      DEMO_MODE: 'c',
      DEMO_PORT: 'eighty',
      DEMO_APPS: '{not json',
      DEMO_FLAG2: 'TRUE',
      DEMO_NAME: 'anything goes',
    })
  );
  const byName = Object.fromEntries(warnings.map((w) => [w.name, w.expected]));
  assert.equal(byName.ENABLE_DRAFT_PR, '0 or 1');
  assert.match(byName.DEMO_MODE, /one of: a, b/);
  assert.equal(byName.DEMO_PORT, 'a number');
  assert.equal(byName.DEMO_APPS, 'valid JSON');
  assert.ok(!('DEMO_FLAG2' in byName), 'boolean is case-insensitive');
  assert.ok(!('DEMO_NAME' in byName), 'strings are never warned');
});

test('validateValues skips dynamic and empty values', () => {
  const warnings = validateValues(merged, {
    ENABLE_DRAFT_PR: { value: '$(compute)', dynamic: true, source: 'envrc' },
    DEMO_PORT: { value: '', dynamic: false, source: 'env-file' },
  });
  assert.deepEqual(warnings, []);
});
