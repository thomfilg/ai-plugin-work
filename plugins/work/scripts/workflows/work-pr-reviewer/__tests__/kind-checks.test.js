'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getKindCheckRegistry } = require('../lib/kind-checks/kind-registry');
const devops = require('../lib/kind-checks/devops');
const e2e = require('../lib/kind-checks/e2e');

function makeWorktree({ tasks = '', files = {}, prContext = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-kind-'));
  const worktreeRoot = path.join(root, 'wt');
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const tasksDir = path.join(root, 'tasks', 'ECHO-7777');
  fs.mkdirSync(tasksDir, { recursive: true });
  if (tasks) fs.writeFileSync(path.join(tasksDir, 'tasks.md'), tasks);
  if (prContext)
    fs.writeFileSync(path.join(tasksDir, 'pr-review-context.json'), JSON.stringify(prContext));
  for (const [rel, contents] of Object.entries(files)) {
    const p = path.join(worktreeRoot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }
  return { root, tasksDir, worktreeRoot };
}

test('kind-registry exposes all six kinds', () => {
  const r = getKindCheckRegistry();
  for (const k of ['frontend', 'backend', 'wiring', 'e2e', 'devops', 'fullstack']) {
    assert.ok(r[k]);
  }
});

test('devops BLOCKS on secret-leak suspect', () => {
  const { root, tasksDir, worktreeRoot } = makeWorktree({
    tasks: '<!-- devops -->',
    files: { '.github/workflows/ci.yml': 'env:\n  API_KEY: "abcd1234abcd1234"\n' },
    prContext: { number: 1, files: ['.github/workflows/ci.yml'] },
  });
  const r = devops.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('secret')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('devops BLOCKS on app-source drift', () => {
  const { root, tasksDir, worktreeRoot } = makeWorktree({
    tasks: '<!-- devops -->',
    files: { '.github/workflows/ci.yml': 'name: ci\n' },
    prContext: { number: 1, files: ['.github/workflows/ci.yml', 'app/api/foo.ts'] },
  });
  const r = devops.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('app/api/foo.ts')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('e2e BLOCKS on .only', () => {
  const { root, tasksDir, worktreeRoot } = makeWorktree({
    tasks: '<!-- e2e -->',
    files: {
      'tests/e2e/foo.spec.ts': "test.only('x', async () => { expect(1).toBe(1); });\n",
    },
    prContext: { number: 1, files: ['tests/e2e/foo.spec.ts'] },
  });
  const r = e2e.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('.only')));
  fs.rmSync(root, { recursive: true, force: true });
});
