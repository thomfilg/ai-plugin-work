'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ENGINE_PATH = path.join(__dirname, '..', 'shared', 'engine.js');

function loadEngine() {
  // Clear cache to ensure fresh load each test.
  delete require.cache[require.resolve(ENGINE_PATH)];
  return require(ENGINE_PATH);
}

test('engine: empty registry produces no violations', () => {
  const { RuleEngine } = loadEngine();
  const engine = new RuleEngine();
  const result = engine.run({ files: [{ path: 'a.js', source: 'x' }], allowlist: new Set() });
  assert.deepEqual(result.violations, []);
});

test('engine: single fake rule produces a violation per-file', () => {
  const { RuleEngine } = loadEngine();
  const engine = new RuleEngine();
  engine.register({
    id: 'fake',
    defaultThreshold: 1,
    check(filePath, _source) {
      return [{ line: 1, message: 'boom' }];
    },
  });
  const result = engine.run({
    files: [{ path: 'a.js', source: 'x' }],
    allowlist: new Set(),
  });
  assert.equal(result.violations.length, 1);
  const v = result.violations[0];
  assert.equal(v.file, 'a.js');
  assert.equal(v.line, 1);
  assert.equal(v.rule, 'fake');
  assert.equal(v.severity, 'error');
  assert.equal(v.message, 'boom');
});

test('engine: allowlisted file downgrades severity from error to warning (rule still runs)', () => {
  const { RuleEngine } = loadEngine();
  const engine = new RuleEngine();
  let callCount = 0;
  engine.register({
    id: 'fake',
    defaultThreshold: 1,
    check(filePath, _source) {
      callCount += 1;
      return [{ line: 7, message: 'noisy' }];
    },
  });
  const result = engine.run({
    files: [{ path: 'allowed.js', source: 'x' }],
    allowlist: new Set(['allowed.js']),
  });
  assert.equal(callCount, 1, 'rule must still run on allowlisted files');
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].severity, 'warning');
  assert.equal(result.violations[0].file, 'allowed.js');
  assert.equal(result.violations[0].rule, 'fake');
});

test('engine: non-allowlisted files retain error severity', () => {
  const { RuleEngine } = loadEngine();
  const engine = new RuleEngine();
  engine.register({
    id: 'fake',
    defaultThreshold: 1,
    check() {
      return [{ line: 2, message: 'bad' }];
    },
  });
  const result = engine.run({
    files: [
      { path: 'a.js', source: 'x' },
      { path: 'b.js', source: 'y' },
    ],
    allowlist: new Set(['b.js']),
  });
  const a = result.violations.find((v) => v.file === 'a.js');
  const b = result.violations.find((v) => v.file === 'b.js');
  assert.equal(a.severity, 'error');
  assert.equal(b.severity, 'warning');
});
