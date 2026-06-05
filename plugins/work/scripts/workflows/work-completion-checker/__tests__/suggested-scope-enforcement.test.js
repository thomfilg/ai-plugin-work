'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');

const phase = require('../lib/phases/suggested_scope_enforcement');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gh282-task5-'));
}

/**
 * Build a fixture ctx with tasksDir + worktreeRoot. Writes tasks.md if provided
 * and writes a pr-context.json file list so readChangedFiles is deterministic.
 */
function buildCtx({ tasks, changedFiles = [] }) {
  const root = mkTmp();
  const tasksDir = path.join(root, 'tasks', 'GH-282');
  fs.mkdirSync(tasksDir, { recursive: true });
  if (tasks !== undefined) {
    fs.writeFileSync(path.join(tasksDir, 'tasks.md'), tasks, 'utf8');
  }
  fs.writeFileSync(
    path.join(tasksDir, 'pr-context.json'),
    JSON.stringify({ files: changedFiles }, null, 2),
    'utf8',
  );
  return {
    ctx: {
      tasksDir,
      worktreeRoot: root,
      failures: [],
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Stub childProcess.spawnSync so calls to `git diff --numstat ...`
 * return a deterministic numstat payload. Returns a restore function.
 */
function stubNumstat(numstatStdout) {
  const original = childProcess.spawnSync;
  childProcess.spawnSync = function patched(cmd, args, opts) {
    if (cmd === 'git' && Array.isArray(args) && args[0] === 'diff' && args.includes('--numstat')) {
      return { status: 0, stdout: numstatStdout, stderr: '' };
    }
    return original.call(this, cmd, args, opts);
  };
  return () => {
    childProcess.spawnSync = original;
  };
}

test.describe('suggested_scope_enforcement phase', () => {
  test('Suggested Scope file missing from diff fails completion', async () => {
    const tasks = [
      '# Tasks',
      '',
      '## Task 1 — example',
      '',
      '### Files in scope',
      '',
      '- `apps/web/src/pages/Page.tsx`',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildCtx({
      tasks,
      changedFiles: ['some/other/file.ts'],
    });
    const restore = stubNumstat('');
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, false, 'must fail when scoped file absent from diff');
      const rec = ctx.failures.find((f) => f.checkType === 'suggested_scope');
      assert.ok(rec, 'a suggested_scope failure record must be pushed');
      assert.equal(rec.expected, 'apps/web/src/pages/Page.tsx in diff');
      assert.equal(rec.observed, 'missing from git diff --name-only');
    } finally {
      restore();
      cleanup();
    }
  });

  test('Suggested Scope all files present in diff passes', async () => {
    const tasks = [
      '# Tasks',
      '',
      '## Task 1 — example',
      '',
      '### Files in scope',
      '',
      '- `apps/web/src/pages/Page.tsx`',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildCtx({
      tasks,
      changedFiles: ['apps/web/src/pages/Page.tsx'],
    });
    const restore = stubNumstat('3\t1\tapps/web/src/pages/Page.tsx\n');
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, true, 'must pass when all scoped files present with non-empty hunks');
      assert.equal(
        ctx.failures.filter((f) => f.checkType === 'suggested_scope').length,
        0,
        'no failure records pushed',
      );
    } finally {
      restore();
      cleanup();
    }
  });

  test('Suggested Scope file in --name-only but --numstat shows 0\\t0 fails (AC 5.1.1(d))', async () => {
    const tasks = [
      '# Tasks',
      '',
      '## Task 1 — example',
      '',
      '### Files in scope',
      '',
      '- `apps/web/src/pages/Page.tsx`',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildCtx({
      tasks,
      changedFiles: ['apps/web/src/pages/Page.tsx'],
    });
    const restore = stubNumstat('0\t0\tapps/web/src/pages/Page.tsx\n');
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, false, 'must fail when scoped file has 0\\t0 numstat');
      const rec = ctx.failures.find((f) => f.checkType === 'suggested_scope');
      assert.ok(rec, 'a suggested_scope failure record must be pushed');
      assert.equal(rec.observed, 'in diff but unchanged content');
    } finally {
      restore();
      cleanup();
    }
  });

  test('tasks.md without a Suggested Scope section is skipped (backward compatible)', async () => {
    const tasks = [
      '# Tasks',
      '',
      '## Task 1 — example',
      '',
      '### Type',
      'wiring',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildCtx({
      tasks,
      changedFiles: ['some/file.ts'],
    });
    const restore = stubNumstat('');
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, true);
      assert.match(String(result.summary || ''), /no Suggested Scope section/i);
      assert.match(String(result.summary || ''), /skipped/i);
    } finally {
      restore();
      cleanup();
    }
  });
});
