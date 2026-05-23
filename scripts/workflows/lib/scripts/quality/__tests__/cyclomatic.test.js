'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rule = require('../rules/cyclomatic');

test('cyclomatic: module shape', () => {
  assert.equal(rule.id, 'cyclomatic');
  assert.equal(rule.defaultThreshold, 10);
  assert.equal(typeof rule.check, 'function');
});

test('cyclomatic: function with 11 decision points violates', () => {
  // 1 (base) + 11 decisions = 12
  const source = `function foo(a, b, c) {
  if (a) return 1;
  if (b) return 2;
  if (c) return 3;
  for (let i = 0; i < 10; i++) {}
  while (a) break;
  switch (a) {
    case 1: break;
    case 2: break;
    case 3: break;
  }
  try {} catch (e) {}
  return a && b || c ? 1 : 0;
}
`;
  const violations = rule.check('src/foo.js', source);
  assert.equal(violations.length, 1);
  const v = violations[0];
  assert.equal(v.rule, 'cyclomatic');
  assert.equal(v.line, 1);
  assert.match(v.message, /cyclomatic-complexity > 10 \(\d+\) in foo/);
});

test('cyclomatic: function with 10 complexity is clean', () => {
  // 1 (base) + 9 decisions = 10 — at threshold, no violation
  const source = `function bar(a, b) {
  if (a) return 1;
  if (b) return 2;
  for (let i = 0; i < 10; i++) {}
  while (a) break;
  switch (a) {
    case 1: break;
    case 2: break;
  }
  try {} catch (e) {}
  return a && b;
}
`;
  const violations = rule.check('src/bar.js', source);
  assert.deepEqual(violations, []);
});

test('cyclomatic: simple function is clean', () => {
  const source = `function tiny() {\n  return 1;\n}\n`;
  const violations = rule.check('src/tiny.js', source);
  assert.deepEqual(violations, []);
});

test('cyclomatic: nested functions counted independently', () => {
  // outer has very low complexity. inner has 12 (1 + 11).
  const inner = `  function inner(a, b, c) {
    if (a) return 1;
    if (b) return 2;
    if (c) return 3;
    if (a && b) return 4;
    if (a || c) return 5;
    for (let i = 0; i < 5; i++) {}
    while (a) break;
    switch (a) { case 1: break; case 2: break; }
    try {} catch (e) {}
    return a ? 1 : 0;
  }
`;
  const source = `function outer() {
${inner}
  return inner(1, 2, 3);
}
`;
  const violations = rule.check('src/nest.js', source);
  const names = violations.map((v) => v.message);
  assert.ok(names.some((m) => /in inner/.test(m)), 'expected inner violation');
  assert.ok(
    !names.some((m) => /in outer/.test(m)),
    'expected no outer violation'
  );
});

test('cyclomatic: && / || / ? inside strings and comments are ignored', () => {
  // Without stripping: many fake decision points. With stripping: just 1.
  const source = `function strs() {
  // if (a && b || c) return 1;
  /* if (a) if (b) if (c) && && && || || || ? : ? : */
  const s1 = "a && b || c ? d : e && f || g ? h : i";
  const s2 = 'if (x) if (y) if (z) && && ||';
  const s3 = \`a && b || c ? d : e\`;
  if (true) return 1;
  return s1 + s2 + s3;
}
`;
  const violations = rule.check('src/strs.js', source);
  assert.deepEqual(violations, []);
});

test('cyclomatic: arrow function detected', () => {
  const source = `const baz = (a, b, c) => {
  if (a) return 1;
  if (b) return 2;
  if (c) return 3;
  if (a && b) return 4;
  if (b && c) return 5;
  if (a && c) return 6;
  for (let i = 0; i < 5; i++) {}
  while (a) break;
  switch (a) { case 1: break; case 2: break; }
  try {} catch (e) {}
  return a ? 1 : 0;
};
`;
  const violations = rule.check('src/baz.js', source);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /in baz/);
});

test('cyclomatic: pure function — no filesystem I/O', () => {
  const source = `function f() {
  if (1) if (1) if (1) if (1) if (1) if (1) if (1) if (1) if (1) if (1) if (1) return 1;
  return 0;
}
`;
  const violations = rule.check('/nonexistent/path.js', source);
  assert.equal(violations.length, 1);
});
