'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const RULE_PATH = path.join(__dirname, '..', 'rules', 'duplicate-blocks.js');

function loadRule() {
  delete require.cache[require.resolve(RULE_PATH)];
  return require(RULE_PATH);
}

function tokenSeq(n, prefix = 't') {
  const parts = [];
  for (let i = 0; i < n; i += 1) parts.push(`${prefix}${i}`);
  return parts.join(' ');
}

test('duplicate-blocks: exports rule shape with id, defaultThreshold=50, checkAll', () => {
  const rule = loadRule();
  assert.equal(rule.id, 'duplicate-blocks');
  assert.equal(rule.defaultThreshold, 50);
  assert.equal(typeof rule.checkAll, 'function');
});

test('duplicate-blocks: two files sharing a 60-token identical block produce one violation per file pair', () => {
  const rule = loadRule();
  const shared = tokenSeq(60, 's');
  const fileA = `prefixA1 prefixA2 prefixA3 ${shared} suffixA1 suffixA2`;
  const fileB = `prefixB1 ${shared} suffixB1 suffixB2 suffixB3`;
  const violations = rule.checkAll([
    { path: 'a.js', source: fileA },
    { path: 'b.js', source: fileB },
  ]);
  assert.ok(Array.isArray(violations));
  assert.ok(violations.length >= 1, 'expected at least one violation');
  const v = violations.find((x) => x.rule === 'duplicate-blocks');
  assert.ok(v, 'violation must have rule=duplicate-blocks');
  assert.ok(v.file === 'a.js' || v.file === 'b.js');
  assert.equal(typeof v.line, 'number');
  assert.match(v.message, /duplicate code block/i);
  assert.match(v.message, /60 tokens/);
  // message references the other file
  if (v.file === 'a.js') assert.match(v.message, /b\.js/);
  else assert.match(v.message, /a\.js/);
});

test('duplicate-blocks: 40-token overlap (below 50 threshold) produces no violation', () => {
  const rule = loadRule();
  const shared = tokenSeq(40, 'x');
  const fileA = `aa1 aa2 ${shared} aa3`;
  const fileB = `bb1 ${shared} bb2 bb3`;
  const violations = rule.checkAll([
    { path: 'a.js', source: fileA },
    { path: 'b.js', source: fileB },
  ]);
  assert.deepEqual(violations, []);
});

test('duplicate-blocks: two files with identical content produce a violation', () => {
  const rule = loadRule();
  const content = tokenSeq(80, 'k');
  const violations = rule.checkAll([
    { path: 'a.js', source: content },
    { path: 'b.js', source: content },
  ]);
  assert.ok(violations.length >= 1);
  const files = new Set(violations.map((v) => v.file));
  assert.ok(files.has('a.js') || files.has('b.js'));
});

test('duplicate-blocks: single file with no peers produces no violations', () => {
  const rule = loadRule();
  const violations = rule.checkAll([{ path: 'solo.js', source: tokenSeq(200) }]);
  assert.deepEqual(violations, []);
});

test('duplicate-blocks: exactly 50-token shared block triggers violation (boundary)', () => {
  const rule = loadRule();
  const shared = tokenSeq(50, 'b');
  const fileA = `aa ${shared} zz`;
  const fileB = `cc ${shared} yy`;
  const violations = rule.checkAll([
    { path: 'a.js', source: fileA },
    { path: 'b.js', source: fileB },
  ]);
  assert.ok(violations.length >= 1, 'exact-50 window should still trigger');
  const v = violations[0];
  assert.match(v.message, /50 tokens/);
});
