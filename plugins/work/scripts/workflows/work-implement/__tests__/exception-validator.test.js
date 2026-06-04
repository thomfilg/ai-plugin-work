/**
 * Tests for exception-validator.js — pure validation module
 *
 * Run with: node --test workflows/work-implement/__tests__/exception-validator.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MOD_PATH = path.join(__dirname, '..', 'exception-validator.js');

// ─── Cycle 1: validateExceptionCategory ─────────────────────────────────────

describe('validateExceptionCategory', () => {
  function load() {
    return require(MOD_PATH);
  }

  it('accepts "checkpoint" as valid', () => {
    const { validateExceptionCategory } = load();
    const result = validateExceptionCategory('checkpoint');
    assert.deepStrictEqual(result, { valid: true, reason: '' });
  });

  it('accepts "config-only" as valid', () => {
    const { validateExceptionCategory } = load();
    const result = validateExceptionCategory('config-only');
    assert.deepStrictEqual(result, { valid: true, reason: '' });
  });

  it('accepts "file-move" as valid', () => {
    const { validateExceptionCategory } = load();
    const result = validateExceptionCategory('file-move');
    assert.deepStrictEqual(result, { valid: true, reason: '' });
  });

  it('accepts "mechanical-refactor" as valid', () => {
    const { validateExceptionCategory } = load();
    const result = validateExceptionCategory('mechanical-refactor');
    assert.deepStrictEqual(result, { valid: true, reason: '' });
  });

  it('rejects arbitrary string', () => {
    const { validateExceptionCategory } = load();
    const result = validateExceptionCategory('random-thing');
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.length > 0, 'reason should be non-empty');
  });

  it('rejects null', () => {
    const { validateExceptionCategory } = load();
    const result = validateExceptionCategory(null);
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.length > 0);
  });

  it('rejects undefined', () => {
    const { validateExceptionCategory } = load();
    const result = validateExceptionCategory(undefined);
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.length > 0);
  });

  it('rejects empty string', () => {
    const { validateExceptionCategory } = load();
    const result = validateExceptionCategory('');
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.length > 0);
  });
});

// ─── Cycle 2: checkNewExportedCode ──────────────────────────────────────────

describe('checkNewExportedCode', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exc-val-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function load() {
    return require(MOD_PATH);
  }

  function tmpFile(name, content) {
    const fp = path.join(tmpDir, name);
    fs.writeFileSync(fp, content);
    return fp;
  }

  it('detects module.exports', () => {
    const { checkNewExportedCode } = load();
    const f = tmpFile('a.js', 'module.exports = { foo };\n');
    const result = checkNewExportedCode([f]);
    assert.strictEqual(result.hasNewExports, true);
    assert.deepStrictEqual(result.files, [f]);
  });

  it('detects export default function', () => {
    const { checkNewExportedCode } = load();
    const f = tmpFile('b.ts', 'export default function handler() {}\n');
    const result = checkNewExportedCode([f]);
    assert.strictEqual(result.hasNewExports, true);
    assert.deepStrictEqual(result.files, [f]);
  });

  it('detects export function', () => {
    const { checkNewExportedCode } = load();
    const f = tmpFile('c.tsx', 'export function MyComponent() {}\n');
    const result = checkNewExportedCode([f]);
    assert.strictEqual(result.hasNewExports, true);
    assert.deepStrictEqual(result.files, [f]);
  });

  it('detects export const', () => {
    const { checkNewExportedCode } = load();
    const f = tmpFile('d.jsx', 'export const bar = 42;\n');
    const result = checkNewExportedCode([f]);
    assert.strictEqual(result.hasNewExports, true);
    assert.deepStrictEqual(result.files, [f]);
  });

  it('ignores .json files', () => {
    const { checkNewExportedCode } = load();
    const f = tmpFile('pkg.json', '{"main":"index.js"}\n');
    const result = checkNewExportedCode([f]);
    assert.strictEqual(result.hasNewExports, false);
    assert.deepStrictEqual(result.files, []);
  });

  it('ignores .md files', () => {
    const { checkNewExportedCode } = load();
    const f = tmpFile('README.md', 'export const x = 1;\n');
    const result = checkNewExportedCode([f]);
    assert.strictEqual(result.hasNewExports, false);
    assert.deepStrictEqual(result.files, []);
  });

  it('ignores .yml files', () => {
    const { checkNewExportedCode } = load();
    const f = tmpFile('config.yml', 'export: true\n');
    const result = checkNewExportedCode([f]);
    assert.strictEqual(result.hasNewExports, false);
    assert.deepStrictEqual(result.files, []);
  });

  it('returns empty for empty file list', () => {
    const { checkNewExportedCode } = load();
    const result = checkNewExportedCode([]);
    assert.deepStrictEqual(result, { hasNewExports: false, files: [] });
  });

  it('gracefully ignores non-existent files', () => {
    const { checkNewExportedCode } = load();
    const result = checkNewExportedCode(['/tmp/does-not-exist-xyz.js']);
    assert.strictEqual(result.hasNewExports, false);
    assert.deepStrictEqual(result.files, []);
  });

  it('reports multiple files with exports', () => {
    const { checkNewExportedCode } = load();
    const f1 = tmpFile('x.js', 'module.exports = {};\n');
    const f2 = tmpFile('y.ts', 'export const z = 1;\n');
    const f3 = tmpFile('z.js', '// no exports\nconst a = 1;\n');
    const result = checkNewExportedCode([f1, f2, f3]);
    assert.strictEqual(result.hasNewExports, true);
    assert.deepStrictEqual(result.files.sort(), [f1, f2].sort());
  });
});

// ─── Cycle 3: isCheckpointTask ──────────────────────────────────────────────

describe('isCheckpointTask', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exc-val-cp-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function load() {
    return require(MOD_PATH);
  }

  function writeTasksMd(content) {
    const ticketDir = path.join(tmpDir, 'TICK-1');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, 'tasks.md'), content);
    return ticketDir;
  }

  it('returns true for checkpoint task', () => {
    const { isCheckpointTask } = load();
    writeTasksMd(
      '## Task 1\n### Type\ncheckpoint\n### Dependencies\nNone\n### Acceptance Criteria\n- done\n'
    );
    const result = isCheckpointTask('TICK-1', 1, tmpDir);
    assert.strictEqual(result, true);
  });

  it('returns false for non-checkpoint task', () => {
    const { isCheckpointTask } = load();
    writeTasksMd(
      '## Task 1\n### Type\nimplementation\n### Dependencies\nNone\n### Acceptance Criteria\n- done\n'
    );
    const result = isCheckpointTask('TICK-1', 1, tmpDir);
    assert.strictEqual(result, false);
  });

  it('returns false when tasks.md missing', () => {
    const { isCheckpointTask } = load();
    const result = isCheckpointTask('NO-EXIST', 1, tmpDir);
    assert.strictEqual(result, false);
  });

  it('returns false for invalid taskNum', () => {
    const { isCheckpointTask } = load();
    writeTasksMd(
      '## Task 1\n### Type\nimplementation\n### Dependencies\nNone\n### Acceptance Criteria\n- done\n'
    );
    const result = isCheckpointTask('TICK-1', 99, tmpDir);
    assert.strictEqual(result, false);
  });

  it('returns false for non-numeric taskNum', () => {
    const { isCheckpointTask } = load();
    writeTasksMd(
      '## Task 1\n### Type\ncheckpoint\n### Dependencies\nNone\n### Acceptance Criteria\n- done\n'
    );
    const result = isCheckpointTask('TICK-1', 'abc', tmpDir);
    assert.strictEqual(result, false);
  });

  it('returns false for task with checkpoint in title but non-checkpoint type', () => {
    const { isCheckpointTask } = load();
    writeTasksMd(
      '## Task 1 — Checkpoint restore logic\n### Type\nbackend\n### Dependencies\nNone\n### Acceptance Criteria\n- done\n'
    );
    const result = isCheckpointTask('TICK-1', 1, tmpDir);
    assert.strictEqual(result, false);
  });
});

// ─── ALLOWED_CATEGORIES export ──────────────────────────────────────────────

describe('ALLOWED_CATEGORIES', () => {
  function load() {
    return require(MOD_PATH);
  }

  it('is a frozen array with exactly 4 entries', () => {
    const { ALLOWED_CATEGORIES } = load();
    assert.ok(Array.isArray(ALLOWED_CATEGORIES));
    assert.strictEqual(ALLOWED_CATEGORIES.length, 4);
    assert.ok(Object.isFrozen(ALLOWED_CATEGORIES));
  });

  it('contains the expected categories', () => {
    const { ALLOWED_CATEGORIES } = load();
    assert.deepStrictEqual(
      [...ALLOWED_CATEGORIES].sort(),
      ['checkpoint', 'config-only', 'file-move', 'mechanical-refactor'].sort()
    );
  });
});
