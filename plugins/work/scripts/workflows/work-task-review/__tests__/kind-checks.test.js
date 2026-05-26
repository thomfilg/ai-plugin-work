'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getKindCheckRegistry } = require('../lib/kind-checks/kind-registry');
const wiring = require('../lib/kind-checks/wiring');
const e2e = require('../lib/kind-checks/e2e');
const devops = require('../lib/kind-checks/devops');
const backend = require('../lib/kind-checks/backend');

function makeWorktree({ brief = '', tasks = '', files = {}, taskCtx = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-review-kind-'));
  const worktreeRoot = path.join(root, 'wt');
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const tasksDir = path.join(root, 'tasks', 'ECHO-7777');
  fs.mkdirSync(tasksDir, { recursive: true });
  if (brief) fs.writeFileSync(path.join(tasksDir, 'brief.md'), brief);
  if (tasks) fs.writeFileSync(path.join(tasksDir, 'tasks.md'), tasks);
  if (taskCtx)
    fs.writeFileSync(path.join(tasksDir, 'task-review-context.json'), JSON.stringify(taskCtx));
  for (const [rel, contents] of Object.entries(files)) {
    const p = path.join(worktreeRoot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }
  return { root, tasksDir, worktreeRoot };
}

test('kind-registry exposes all six task-review kinds', () => {
  const r = getKindCheckRegistry();
  for (const k of ['frontend', 'backend', 'wiring', 'e2e', 'devops', 'fullstack']) {
    assert.ok(r[k]);
    assert.equal(typeof r[k].appliesTo, 'function');
    assert.equal(typeof r[k].validate, 'function');
  }
});

test('wiring BLOCKS on backend drift when brief forbids backend changes', () => {
  const { root, tasksDir, worktreeRoot } = makeWorktree({
    brief: '## Out of scope\n- no backend changes\n',
    tasks: '<!-- wiring -->',
    taskCtx: {
      ticket: 'ECHO-7777',
      files: ['app/api/foo.ts', 'components/Bar.tsx'],
    },
  });
  const r = wiring.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('app/api/foo.ts')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('wiring PASSES when no backend drift', () => {
  const { root, tasksDir, worktreeRoot } = makeWorktree({
    brief: '## Out of scope\n- no backend changes\n',
    tasks: '<!-- wiring -->',
    taskCtx: { ticket: 'ECHO-7777', files: ['components/Bar.tsx'] },
  });
  const r = wiring.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('e2e BLOCKS on .only marker', () => {
  const { root, tasksDir, worktreeRoot } = makeWorktree({
    tasks: '<!-- e2e -->',
    files: {
      'tests/e2e/foo.spec.ts': "test.only('x', async () => { expect(1).toBe(1); });\n",
    },
    taskCtx: { ticket: 'ECHO-7777', files: ['tests/e2e/foo.spec.ts'] },
  });
  const r = e2e.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('.only')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('devops BLOCKS on secret-shaped literal', () => {
  const { root, tasksDir, worktreeRoot } = makeWorktree({
    tasks: '<!-- devops -->',
    files: { '.github/workflows/ci.yml': 'env:\n  API_KEY: "abcd1234abcd1234"\n' },
    taskCtx: { ticket: 'ECHO-7777', files: ['.github/workflows/ci.yml'] },
  });
  const r = devops.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('secret')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('backend warns on `any` introduction', () => {
  const { root, tasksDir, worktreeRoot } = makeWorktree({
    tasks: '<!-- backend -->',
    files: { 'app/api/foo.ts': 'export function f(x: any) { return x; }\n' },
    taskCtx: { ticket: 'ECHO-7777', files: ['app/api/foo.ts'] },
  });
  const r = backend.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, true);
  assert.ok((r.warnings || []).some((w) => /any/.test(w)));
  fs.rmSync(root, { recursive: true, force: true });
});
