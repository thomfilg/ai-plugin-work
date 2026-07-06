'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getKindCheckRegistry } = require('../lib/kind-checks/kind-registry');
const e2e = require('../lib/kind-checks/e2e');
const devops = require('../lib/kind-checks/devops');

function makeWorktree({ tasks = '', files = {}, prContext = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-kind-'));
  const worktreeRoot = path.join(root, 'wt');
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const tasksDir = path.join(root, 'tasks', 'ECHO-7777');
  fs.mkdirSync(tasksDir, { recursive: true });
  if (tasks) fs.writeFileSync(path.join(tasksDir, 'tasks.md'), tasks);
  if (prContext)
    fs.writeFileSync(path.join(tasksDir, 'pr-context.json'), JSON.stringify(prContext));
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
    assert.ok(r[k], `expected "${k}" in registry`);
    assert.equal(typeof r[k].appliesTo, 'function');
    assert.equal(typeof r[k].validate, 'function');
  }
});

test('e2e BLOCKS on `.only` in committed spec', () => {
  const { root, tasksDir, worktreeRoot } = makeWorktree({
    tasks: '<!-- e2e -->',
    files: {
      'tests/e2e/foo.spec.ts':
        "import { test, expect } from '@playwright/test';\ntest.only('x', async () => { expect(1).toBe(1); });\n",
    },
    prContext: { base: 'origin/main', files: ['tests/e2e/foo.spec.ts'] },
  });
  const r = e2e.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('.only')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('e2e BLOCKS on spec with no expect()', () => {
  const { root, tasksDir, worktreeRoot } = makeWorktree({
    tasks: '<!-- e2e -->',
    files: {
      'tests/e2e/bar.spec.ts':
        "import { test } from '@playwright/test';\ntest('noop', async () => {});\n",
    },
    prContext: { base: 'origin/main', files: ['tests/e2e/bar.spec.ts'] },
  });
  const r = e2e.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('expect(')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('devops BLOCKS on app-source drift', () => {
  const { root, tasksDir, worktreeRoot } = makeWorktree({
    tasks: '<!-- devops -->',
    files: {},
    prContext: {
      base: 'origin/main',
      files: ['.github/workflows/ci.yml', 'app/api/foo.ts'],
    },
  });
  const r = devops.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('app/api/foo.ts')));
  fs.rmSync(root, { recursive: true, force: true });
});

// ─── GH-652 regression: checks must FIRE for canonical closed-taxonomy tasks.md ───

const CANONICAL_E2E_TASKS = [
  '# Tasks',
  '',
  '## Task 1',
  '',
  '### Type',
  'tests-only',
  '',
  '### Files in scope',
  '- `tests/e2e/bar.spec.ts`',
  '',
].join('\n');

test('GH-652: e2e check APPLIES and FIRES on a canonical closed-taxonomy tasks.md', () => {
  const { root, tasksDir, worktreeRoot } = makeWorktree({
    tasks: CANONICAL_E2E_TASKS,
    files: {
      'tests/e2e/bar.spec.ts':
        "import { test } from '@playwright/test';\ntest('noop', async () => {});\n",
    },
    prContext: { base: 'origin/main', files: ['tests/e2e/bar.spec.ts'] },
  });
  assert.equal(
    e2e.appliesTo({ tasksDir }),
    true,
    'e2e kind must be derived from the canonical `### Files in scope` (closed Type enum carries no domain)'
  );
  const r = e2e.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('expect(')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('GH-393: e2e no-expect check skips fixtures/, helpers/ and non-code files under tests/e2e', () => {
  const { root, tasksDir, worktreeRoot } = makeWorktree({
    tasks: CANONICAL_E2E_TASKS,
    files: {
      'tests/e2e/bar.spec.ts':
        "import { test, expect } from '@playwright/test';\ntest('x', async () => { expect(1).toBe(1); });\n",
      'tests/e2e/fixtures/tasks/admin/type-user.ts':
        "export async function typeUser(page) { await page.fill('#u', 'x'); }\n",
      'tests/e2e/helpers/login.ts': 'export async function login(page) {}\n',
      'tests/e2e/domain-index.json': '{"generatedAt":"2026-06-11","totalFiles":3748}\n',
    },
    prContext: {
      base: 'origin/main',
      files: [
        'tests/e2e/bar.spec.ts',
        'tests/e2e/fixtures/tasks/admin/type-user.ts',
        'tests/e2e/helpers/login.ts',
        'tests/e2e/domain-index.json',
      ],
    },
  });
  const r = e2e.validate({ tasksDir, worktreeRoot });
  assert.equal(
    r.ok,
    true,
    `fixtures/helpers/json must not be treated as specs — errors: ${JSON.stringify(r.errors)}`
  );
  fs.rmSync(root, { recursive: true, force: true });
});
