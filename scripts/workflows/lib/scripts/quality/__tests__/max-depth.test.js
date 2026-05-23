'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rule = require('../rules/max-depth');

test('max-depth: module shape', () => {
  assert.equal(rule.id, 'max-depth');
  assert.equal(rule.defaultThreshold, 4);
  assert.equal(typeof rule.check, 'function');
});

test('max-depth: 5-level nested if violates', () => {
  const source = [
    'function foo() {',           // depth 1 (function body)
    '  if (a) {',                 // depth 2
    '    if (b) {',               // depth 3
    '      if (c) {',             // depth 4
    '        if (d) {',           // depth 5 — innermost open brace
    '          doStuff();',
    '        }',
    '      }',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  const violations = rule.check('src/foo.js', source);
  assert.equal(violations.length, 1);
  const v = violations[0];
  assert.equal(v.rule, 'max-depth');
  assert.equal(v.severity, 'error');
  assert.equal(v.line, 5);
  assert.match(v.message, /max-depth > 4 \(depth 5\)/);
});

test('max-depth: 4-level clean (no violation)', () => {
  const source = [
    'function foo() {',           // depth 1
    '  if (a) {',                 // depth 2
    '    if (b) {',               // depth 3
    '      if (c) {',             // depth 4
    '        doStuff();',
    '      }',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  const violations = rule.check('src/foo.js', source);
  assert.deepEqual(violations, []);
});

test('max-depth: mixed control-flow keywords (for/while/try/switch) count toward depth', () => {
  const source = [
    'function foo() {',           // depth 1
    '  for (let i = 0; i < 10; i++) {', // depth 2
    '    while (cond) {',         // depth 3
    '      try {',                // depth 4
    '        switch (x) {',       // depth 5 — violation
    '          case 1:',
    '            doStuff();',
    '            break;',
    '        }',
    '      } catch (e) {',
    '        handle(e);',
    '      }',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  const violations = rule.check('src/foo.js', source);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'max-depth');
  assert.match(violations[0].message, /max-depth > 4 \(depth 5\)/);
  assert.equal(violations[0].line, 5);
});

test('max-depth: object and array literals do NOT count toward depth', () => {
  const source = [
    'function foo() {',           // depth 1
    '  const obj = {',            // object literal — not a control-flow block
    '    a: {',
    '      b: {',
    '        c: {',
    '          d: 1,',
    '        },',
    '      },',
    '    },',
    '  };',
    '  const arr = [',
    '    [[[[1]]]],',
    '  ];',
    '  return obj;',
    '}',
    '',
  ].join('\n');
  const violations = rule.check('src/foo.js', source);
  assert.deepEqual(violations, []);
});

test('max-depth: do/else also count toward depth', () => {
  const source = [
    'function foo() {',           // depth 1
    '  if (a) {',                 // depth 2
    '  } else {',                 // depth 2 (else)
    '    do {',                   // depth 3
    '      if (b) {',             // depth 4
    '        if (c) {',           // depth 5 — violation
    '          doStuff();',
    '        }',
    '      }',
    '    } while (cond);',
    '  }',
    '}',
    '',
  ].join('\n');
  const violations = rule.check('src/foo.js', source);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'max-depth');
  assert.match(violations[0].message, /depth 5/);
});

test('max-depth: empty source produces no violations', () => {
  assert.deepEqual(rule.check('src/empty.js', ''), []);
  assert.deepEqual(rule.check('src/empty.js', null), []);
});
