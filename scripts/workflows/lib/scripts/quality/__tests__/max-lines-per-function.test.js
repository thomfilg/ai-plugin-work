'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rule = require('../rules/max-lines-per-function');

function bodyLines(n) {
  // Build n lines of trivial statements to fill a function body.
  return Array.from({ length: n }, (_, i) => `  const x${i} = ${i};`).join('\n');
}

test('max-lines-per-function: module shape', () => {
  assert.equal(rule.id, 'max-lines-per-function');
  assert.equal(rule.defaultThreshold, 80);
  assert.equal(typeof rule.check, 'function');
});

test('max-lines-per-function: 90-line function body produces a violation', () => {
  const source = `function foo() {\n${bodyLines(90)}\n}\n`;
  const violations = rule.check('src/foo.js', source);
  assert.equal(violations.length, 1);
  const v = violations[0];
  assert.equal(v.rule, 'max-lines-per-function');
  assert.equal(v.line, 1);
  assert.match(v.message, /max-lines-per-function > 80 \(\d+ lines\) in foo/);
});

test('max-lines-per-function: 80-line function body is clean', () => {
  const source = `function foo() {\n${bodyLines(78)}\n}\n`;
  const violations = rule.check('src/foo.js', source);
  assert.deepEqual(violations, []);
});

test('max-lines-per-function: small function is clean', () => {
  const source = `function tiny() {\n  return 1;\n}\n`;
  const violations = rule.check('src/foo.js', source);
  assert.deepEqual(violations, []);
});

test('max-lines-per-function: arrow function with 90 lines violates', () => {
  const source = `const bar = () => {\n${bodyLines(90)}\n};\n`;
  const violations = rule.check('src/foo.js', source);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'max-lines-per-function');
  assert.match(violations[0].message, /in bar/);
});

test('max-lines-per-function: async function detected', () => {
  const source = `async function baz() {\n${bodyLines(90)}\n}\n`;
  const violations = rule.check('src/foo.js', source);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /in baz/);
});

test('max-lines-per-function: class method detected', () => {
  const source = `class A {\n  qux() {\n${bodyLines(90)}\n  }\n}\n`;
  const violations = rule.check('src/foo.js', source);
  assert.ok(violations.length >= 1);
  assert.ok(violations.some((v) => /in qux/.test(v.message)));
});

test('max-lines-per-function: nested functions counted independently', () => {
  // Outer function has ~95 lines including nested inner. Inner has ~85 lines.
  const inner = `  function inner() {\n${bodyLines(85)}\n  }\n`;
  const source = `function outer() {\n${inner}${bodyLines(5)}\n}\n`;
  const violations = rule.check('src/foo.js', source);
  // Both outer and inner exceed 80
  const names = violations.map((v) => v.message);
  assert.ok(names.some((m) => /in inner/.test(m)), 'expected inner violation');
  assert.ok(names.some((m) => /in outer/.test(m)), 'expected outer violation');
});

test('max-lines-per-function: pure function — no filesystem I/O', () => {
  const source = `function foo() {\n${bodyLines(90)}\n}\n`;
  const violations = rule.check('/nonexistent/path.js', source);
  assert.equal(violations.length, 1);
});
