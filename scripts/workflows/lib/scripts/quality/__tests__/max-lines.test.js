'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rule = require('../rules/max-lines');

function makeSource(lines) {
  return Array.from({ length: lines }, (_, i) => `const x${i} = ${i};`).join('\n');
}

test('max-lines: module shape', () => {
  assert.equal(rule.id, 'max-lines');
  assert.equal(rule.defaultThreshold, 400);
  assert.equal(typeof rule.check, 'function');
});

test('max-lines: file with 500 lines produces one violation', () => {
  const source = makeSource(500);
  const violations = rule.check('src/foo.js', source);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 1);
  assert.equal(violations[0].message, 'max-lines > 400 (500 lines)');
});

test('max-lines: file with exactly 400 lines is clean', () => {
  const source = makeSource(400);
  const violations = rule.check('src/foo.js', source);
  assert.deepEqual(violations, []);
});

test('max-lines: file under 400 lines is clean', () => {
  const source = makeSource(100);
  const violations = rule.check('src/foo.js', source);
  assert.deepEqual(violations, []);
});

test('max-lines: *.test.js files are excluded', () => {
  const source = makeSource(500);
  const violations = rule.check('src/foo.test.js', source);
  assert.deepEqual(violations, []);
});

test('max-lines: *.spec.js files are excluded', () => {
  const source = makeSource(500);
  const violations = rule.check('src/foo.spec.js', source);
  assert.deepEqual(violations, []);
});

test('max-lines: *.md files are excluded', () => {
  const source = makeSource(500);
  const violations = rule.check('docs/readme.md', source);
  assert.deepEqual(violations, []);
});

test('max-lines: pure function — does not read filesystem', () => {
  // Pass a nonexistent path; behavior must depend only on the `source` arg.
  const source = makeSource(500);
  const violations = rule.check('/nonexistent/path/that/does/not/exist.js', source);
  assert.equal(violations.length, 1);
});
