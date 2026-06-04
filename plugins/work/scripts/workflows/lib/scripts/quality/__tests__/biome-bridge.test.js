'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const RULE_PATH = path.join(__dirname, '..', 'rules', 'biome-bridge.js');

function loadRule() {
  delete require.cache[require.resolve(RULE_PATH)];
  return require(RULE_PATH);
}

function fakeSpawn(result) {
  return function spawnSync(_cmd, _args, _opts) {
    return result;
  };
}

test('biome-bridge: exports id, defaultThreshold=15, checkAll', () => {
  const rule = loadRule();
  assert.equal(rule.id, 'biome-bridge');
  assert.equal(rule.defaultThreshold, 15);
  assert.equal(typeof rule.checkAll, 'function');
});

test('biome-bridge: one cognitive-complexity diagnostic folds into one violation', () => {
  const rule = loadRule();
  const biomeJson = {
    diagnostics: [
      {
        category: 'lint/complexity/noExcessiveCognitiveComplexity',
        severity: 'error',
        description: 'Excessive Cognitive Complexity of 22 detected (max: 15) in function bigFn',
        location: {
          path: { file: 'src/big.js' },
          span: [120, 140],
          sourceCode: '',
        },
      },
    ],
  };
  const spawn = fakeSpawn({
    status: 1,
    stdout: Buffer.from(JSON.stringify(biomeJson)),
    stderr: Buffer.from(''),
  });
  const violations = rule.checkAll(
    [{ path: 'src/big.js', source: 'function bigFn(){}' }],
    { spawnSync: spawn },
  );
  assert.equal(violations.length, 1);
  const v = violations[0];
  assert.equal(v.rule, 'cognitive-complexity');
  assert.equal(v.severity, 'error');
  assert.equal(v.file, 'src/big.js');
  assert.equal(typeof v.line, 'number');
  assert.match(v.message, /cognitive-complexity > 15/);
  assert.match(v.message, /\(22\)/);
  assert.match(v.message, /bigFn/);
});

test('biome-bridge: empty diagnostics → empty violations', () => {
  const rule = loadRule();
  const spawn = fakeSpawn({
    status: 0,
    stdout: Buffer.from(JSON.stringify({ diagnostics: [] })),
    stderr: Buffer.from(''),
  });
  const violations = rule.checkAll(
    [{ path: 'src/clean.js', source: 'const x = 1;' }],
    { spawnSync: spawn },
  );
  assert.deepEqual(violations, []);
});

test('biome-bridge: empty file list → empty violations (no spawn)', () => {
  const rule = loadRule();
  let called = false;
  const spawn = () => {
    called = true;
    return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
  };
  const violations = rule.checkAll([], { spawnSync: spawn });
  assert.deepEqual(violations, []);
  assert.equal(called, false);
});

test('biome-bridge: malformed JSON output → throws config error', () => {
  const rule = loadRule();
  const spawn = fakeSpawn({
    status: 1,
    stdout: Buffer.from('not-json-at-all{{{'),
    stderr: Buffer.from(''),
  });
  assert.throws(
    () => rule.checkAll([{ path: 'a.js', source: '' }], { spawnSync: spawn }),
    /biome|json|parse/i,
  );
});

test('biome-bridge: spawn failure (error or null status) → throws config error', () => {
  const rule = loadRule();
  const spawn = () => ({
    status: null,
    error: new Error('ENOENT: npx not found'),
    stdout: Buffer.from(''),
    stderr: Buffer.from(''),
  });
  assert.throws(
    () => rule.checkAll([{ path: 'a.js', source: '' }], { spawnSync: spawn }),
    /biome|spawn|npx/i,
  );
});

test('biome-bridge: ignores non-cognitive-complexity diagnostics', () => {
  const rule = loadRule();
  const biomeJson = {
    diagnostics: [
      {
        category: 'lint/style/useConst',
        severity: 'warning',
        description: 'use const',
        location: { path: { file: 'a.js' }, span: [0, 5] },
      },
      {
        category: 'lint/complexity/noExcessiveCognitiveComplexity',
        severity: 'error',
        description: 'Excessive Cognitive Complexity of 17 detected (max: 15) in function f',
        location: { path: { file: 'a.js' }, span: [0, 5] },
      },
    ],
  };
  const spawn = fakeSpawn({
    status: 1,
    stdout: Buffer.from(JSON.stringify(biomeJson)),
    stderr: Buffer.from(''),
  });
  const violations = rule.checkAll(
    [{ path: 'a.js', source: 'x' }],
    { spawnSync: spawn },
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'cognitive-complexity');
});

test('biome-bridge: invokes npx biome lint --reporter=json with files', () => {
  const rule = loadRule();
  let captured = null;
  const spawn = (cmd, args, opts) => {
    captured = { cmd, args, opts };
    return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({ diagnostics: [] })),
      stderr: Buffer.from(''),
    };
  };
  rule.checkAll(
    [
      { path: 'a.js', source: '' },
      { path: 'b.js', source: '' },
    ],
    { spawnSync: spawn },
  );
  assert.ok(captured, 'spawn should have been called');
  assert.equal(captured.cmd, 'npx');
  assert.ok(captured.args.includes('biome'));
  assert.ok(captured.args.includes('lint'));
  assert.ok(captured.args.some((a) => /--reporter[= ]json/.test(a) || a === '--reporter=json'));
  assert.ok(captured.args.includes('a.js'));
  assert.ok(captured.args.includes('b.js'));
});
