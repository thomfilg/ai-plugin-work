'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const phase = require('../lib/phases/test_pass_crossref');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gh282-task6-'));
}

function buildCtx({ tasks, testReport }) {
  const root = mkTmp();
  const tasksDir = path.join(root, 'tasks', 'GH-282');
  fs.mkdirSync(tasksDir, { recursive: true });
  if (tasks !== undefined) {
    fs.writeFileSync(path.join(tasksDir, 'tasks.md'), tasks, 'utf8');
  }
  if (testReport !== undefined) {
    fs.writeFileSync(path.join(tasksDir, 'tests.check.md'), testReport, 'utf8');
  }
  return {
    ctx: {
      tasksDir,
      worktreeRoot: root,
      failures: [],
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function coverageTasks(rows) {
  const lines = [
    '# Tasks',
    '',
    '## Requirement Coverage',
    '',
    '| ID | Description | Status | Evidence |',
    '| --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    lines.push(`| ${r.id} | ${r.desc || ''} | ${r.status} | ${r.evidence || ''} |`);
  }
  lines.push('');
  return lines.join('\n');
}

test.describe('test_pass_crossref phase', () => {
  test('Requirement is NOT_DELIVERED when its mapped test failed in tests.check.md', async () => {
    const tasks = coverageTasks([
      { id: 'R4', status: 'DELIVERED', evidence: 'foo.test.js:test_R4' },
    ]);
    const testReport = [
      '# Tests Check',
      '',
      '- test_R4 — Status: FAIL',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildCtx({ tasks, testReport });
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, false, 'phase must fail when cited test FAILed');
      const rec = ctx.failures.find((f) => f.checkType === 'test_pass');
      assert.ok(rec, 'a test_pass failure record must be pushed');
      assert.equal(rec.expected, 'test_R4 PASS');
      assert.equal(rec.observed, 'test_R4 FAIL in tests.check.md');
    } finally {
      cleanup();
    }
  });

  test('Requirement remains DELIVERED when its mapped test passed in tests.check.md', async () => {
    const tasks = coverageTasks([
      { id: 'R4', status: 'DELIVERED', evidence: 'foo.test.js:test_R4' },
    ]);
    const testReport = [
      '# Tests Check',
      '',
      '- test_R4 — Status: PASS',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildCtx({ tasks, testReport });
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, true, 'phase must pass when cited test PASSed');
      assert.equal(
        ctx.failures.filter((f) => f.checkType === 'test_pass').length,
        0,
        'no test_pass failure should be pushed',
      );
    } finally {
      cleanup();
    }
  });

  test('Missing tests.check.md fails test_pass_crossref (no silent skip)', async () => {
    const tasks = coverageTasks([
      { id: 'R4', status: 'DELIVERED', evidence: 'foo.test.js:test_R4' },
    ]);
    // No testReport written.
    const { ctx, cleanup } = buildCtx({ tasks });
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, false, 'phase must fail when tests.check.md is missing');
      const rec = ctx.failures.find((f) => f.checkType === 'test_pass');
      assert.ok(rec, 'a test_pass failure record must be pushed');
      assert.equal(
        rec.observed,
        'tests.check.md not found — cannot verify test pass',
      );
    } finally {
      cleanup();
    }
  });

  test('DELIVERED row cites a test that is NOT mentioned in tests.check.md ⇒ "not found" observed (distinct from FAIL)', async () => {
    const tasks = coverageTasks([
      { id: 'R4', status: 'DELIVERED', evidence: 'foo.test.js:test_R4' },
    ]);
    const testReport = [
      '# Tests Check',
      '',
      '- test_other — Status: PASS',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildCtx({ tasks, testReport });
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, false, 'phase must fail when cited test is not in tests.check.md');
      const rec = ctx.failures.find((f) => f.checkType === 'test_pass');
      assert.ok(rec, 'a test_pass failure record must be pushed');
      assert.equal(rec.expected, 'test_R4 PASS');
      assert.match(
        rec.observed,
        /not found in tests\.check\.md/,
        'observed must distinguish "not found" from FAIL',
      );
      assert.doesNotMatch(rec.observed, /FAIL in tests\.check\.md/);
    } finally {
      cleanup();
    }
  });

  test('(d) DELIVERED rows but none cite a test ⇒ ok:true (backward compat)', async () => {
    const tasks = coverageTasks([
      { id: 'R4', status: 'DELIVERED', evidence: 'tasks.md:Task 4' },
    ]);
    const { ctx, cleanup } = buildCtx({ tasks });
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, true, 'phase must pass when no DELIVERED row cites a test');
      assert.equal(
        ctx.failures.filter((f) => f.checkType === 'test_pass').length,
        0,
        'no failure record should be pushed',
      );
    } finally {
      cleanup();
    }
  });
});

test('word-boundary match: test_R1 must NOT match test_R10 substring (no false-positive PASS)', async () => {
  const tasks = coverageTasks([
    { id: 'R1', status: 'DELIVERED', evidence: '`tests/foo.test.js:test_R1`' },
  ]);
  // test_R10 PASSes; test_R1 itself has FAIL line. Substring match would pick up test_R10 line first.
  const report = [
    '# Test Results Report',
    '',
    '- test_R10 — Status: PASS',
    '- test_R1 — Status: FAIL',
    '',
  ].join('\n');
  const { ctx, cleanup } = buildCtx({ tasks, testReport: report });
  try {
    const result = await phase.validate(ctx);
    assert.equal(result.ok, false, 'must NOT silently pass when test_R1 fails (only test_R10 passes)');
    const failed = ctx.failures.find((f) => f.checkType === 'test_pass');
    assert.ok(failed, 'expected a test_pass failure record');
    assert.match(failed.observed, /FAIL in tests\.check\.md/, 'observed must cite FAIL, not pass via substring');
  } finally {
    cleanup();
  }
});
