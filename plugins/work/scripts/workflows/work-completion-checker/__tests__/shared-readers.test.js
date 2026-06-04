'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const shared = require('../lib/kind-checks/shared');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gh282-task2-'));
}

function writeSpec(dir, content) {
  fs.writeFileSync(path.join(dir, 'spec.md'), content, 'utf8');
}

function writeTasks(dir, content) {
  fs.writeFileSync(path.join(dir, 'tasks.md'), content, 'utf8');
}

test.describe('readReuseAudit(specDir)', () => {
  test('returns [{ symbol, line, mustReuse: true }] for spec with one MUST-reuse entry', () => {
    const dir = mkTmp();
    try {
      writeSpec(
        dir,
        [
          '# Spec',
          '',
          '## Reuse Audit',
          '',
          '- `ContentPageToolbar` MUST be reused from `apps/web/src/components/ContentPageToolbar.tsx`',
          '',
          '## Other',
          'unrelated',
          '',
        ].join('\n'),
      );
      assert.equal(typeof shared.readReuseAudit, 'function', 'readReuseAudit must be exported');
      const result = shared.readReuseAudit(dir);
      assert.ok(Array.isArray(result), 'expected an array');
      assert.equal(result.length, 1);
      assert.equal(result[0].symbol, 'ContentPageToolbar');
      assert.equal(result[0].mustReuse, true);
      assert.equal(typeof result[0].line, 'number');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null sentinel when no `## Reuse Audit` heading exists', () => {
    const dir = mkTmp();
    try {
      writeSpec(dir, '# Spec\n\n## Architecture\n\nsome text\n');
      assert.equal(typeof shared.readReuseAudit, 'function', 'readReuseAudit must be exported');
      const result = shared.readReuseAudit(dir);
      assert.equal(result, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('throws when the Reuse Audit section exists but is empty/unparseable', () => {
    const dir = mkTmp();
    try {
      writeSpec(dir, '# Spec\n\n## Reuse Audit\n\n\n## Next\nx\n');
      assert.equal(typeof shared.readReuseAudit, 'function', 'readReuseAudit must be exported');
      assert.throws(() => shared.readReuseAudit(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('readSuggestedScopeFiles(tasksDir)', () => {
  test('returns union of files listed under `### Suggested Scope` blocks', () => {
    const dir = mkTmp();
    try {
      writeTasks(
        dir,
        [
          '# Tasks',
          '',
          '## Task 1 — alpha',
          '',
          '### Suggested Scope',
          '- `path/to/a.js`',
          '- `path/to/b.js`',
          '',
          '## Task 2 — beta',
          '',
          '### Suggested Scope',
          '- `path/to/c.js`',
          '',
        ].join('\n'),
      );
      assert.equal(
        typeof shared.readSuggestedScopeFiles,
        'function',
        'readSuggestedScopeFiles must be exported',
      );
      const result = shared.readSuggestedScopeFiles(dir);
      assert.ok(Array.isArray(result));
      assert.deepEqual(result.sort(), ['path/to/a.js', 'path/to/b.js', 'path/to/c.js'].sort());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('`### Files in scope` wins when both are present (spec Open Q #3)', () => {
    const dir = mkTmp();
    try {
      writeTasks(
        dir,
        [
          '# Tasks',
          '',
          '## Task 1 — alpha',
          '',
          '### Suggested Scope',
          '- `legacy/old.js`',
          '',
          '### Files in scope',
          '- `new/path.js`',
          '',
        ].join('\n'),
      );
      assert.equal(
        typeof shared.readSuggestedScopeFiles,
        'function',
        'readSuggestedScopeFiles must be exported',
      );
      const result = shared.readSuggestedScopeFiles(dir);
      assert.ok(Array.isArray(result));
      assert.ok(result.includes('new/path.js'), 'Files in scope should win');
      assert.ok(!result.includes('legacy/old.js'), 'Suggested Scope should not appear when Files in scope is present');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('present-but-empty `### Files in scope` wins over Suggested Scope (B7: honors authored intent)', () => {
    const dir = mkTmp();
    try {
      writeTasks(
        dir,
        [
          '# Tasks',
          '',
          '## Task 1 — alpha',
          '',
          '### Files in scope',
          '',
          '### Suggested Scope',
          '- `path/to/fallback.js`',
          '',
        ].join('\n'),
      );
      const result = shared.readSuggestedScopeFiles(dir);
      assert.ok(Array.isArray(result));
      // B7: an explicitly empty Files-in-scope means "no files required" and
      // must NOT silently fall back to the legacy Suggested Scope, which may
      // enforce different files.
      assert.deepEqual(result, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null when no Suggested Scope / Files in scope subsection exists in any task', () => {
    const dir = mkTmp();
    try {
      writeTasks(
        dir,
        ['# Tasks', '', '## Task 1 — alpha', '', '### Requirements Covered', '- R1', ''].join('\n'),
      );
      assert.equal(
        typeof shared.readSuggestedScopeFiles,
        'function',
        'readSuggestedScopeFiles must be exported',
      );
      const result = shared.readSuggestedScopeFiles(dir);
      assert.equal(result, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('readTestReport(tasksDir)', () => {
  test('returns { exists: true, content } when tests.check.md exists', () => {
    const dir = mkTmp();
    try {
      const body = '# tests.check.md\n\n- test_R1 PASS\n- test_R2 FAIL\n';
      fs.writeFileSync(path.join(dir, 'tests.check.md'), body, 'utf8');
      assert.equal(typeof shared.readTestReport, 'function', 'readTestReport must be exported');
      const result = shared.readTestReport(dir);
      assert.equal(result.exists, true);
      assert.equal(result.content, body);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns { exists: false } when tests.check.md is absent', () => {
    const dir = mkTmp();
    try {
      assert.equal(typeof shared.readTestReport, 'function', 'readTestReport must be exported');
      const result = shared.readTestReport(dir);
      assert.equal(result.exists, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
