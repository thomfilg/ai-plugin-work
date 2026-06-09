'use strict';

/**
 * task-next.js — Type=tests-only RED-skipped → GREEN → REFACTOR (GH-528).
 *
 * E2E:
 *   - On first invocation, RED is skipped via record-skip-red; state file
 *     shows {skipped: true}.
 *   - On second invocation, with a modified in-scope test file and passing
 *     verifier, GREEN is recorded.
 *   - On third, REFACTOR is recorded.
 *
 * Negative:
 *   - GREEN refuses when scope includes a non-test file.
 *   - GREEN refuses when no in-scope test file was modified.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TASK_NEXT = path.resolve(__dirname, '..', 'task-next.js');
const STATE_FILENAME = 'tdd' + '-phase' + '.json';
const TICKET = 'TEST-528';

function makeWorkspace({ scope, testCmd = 'node --test src/foo.test.js' }) {
  const tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'task-next-to-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-next-to-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: repoRoot });
  // Seed an empty commit so `git diff HEAD` works.
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# seed\n');
  spawnSync('git', ['add', '.'], { cwd: repoRoot });
  spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoRoot });

  // Build tasks.md with Type=tests-only.
  fs.mkdirSync(path.join(tasksBase, TICKET), { recursive: true });
  const md = [
    '# Tasks',
    '',
    '## Task 1 — add coverage',
    '',
    '### Type',
    'tests-only',
    '',
    '### Files in scope',
    ...scope.map((s) => `- ${s}`),
    '',
    '### Test Command',
    '```bash',
    testCmd,
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(tasksBase, TICKET, 'tasks.md'), md);
  fs.writeFileSync(
    path.join(tasksBase, TICKET, '.work' + '-state.json'),
    JSON.stringify({ ticketId: TICKET })
  );
  return { tasksBase, repoRoot };
}

function runTaskNext(tasksBase, repoRoot) {
  return spawnSync('node', [TASK_NEXT, TICKET, 'task1'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      TASKS_BASE: tasksBase,
      WORK_TDD_TOKEN_SKIP: '1',
      WORK_TDD_SKIP_WORKSPACE_CHECK: '1',
    },
  });
}

function readState(tasksBase) {
  const p = path.join(tasksBase, TICKET, 'task1', STATE_FILENAME);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('task-next.js — tests-only RED→GREEN→REFACTOR', () => {
  let ws;
  beforeEach(() => {
    ws = makeWorkspace({ scope: ['src/foo.test.js'] });
    fs.mkdirSync(path.join(ws.repoRoot, 'src'), { recursive: true });
  });
  afterEach(() => {
    if (ws) {
      fs.rmSync(ws.tasksBase, { recursive: true, force: true });
      fs.rmSync(ws.repoRoot, { recursive: true, force: true });
    }
  });

  it('RED is skipped with structured marker on first invocation', () => {
    const r = runTaskNext(ws.tasksBase, ws.repoRoot);
    assert.equal(r.status, 0, `expected 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout, /RED skipped via tests-only/);
    const state = readState(ws.tasksBase);
    assert.equal(state.currentPhase, 'green');
    const cycle = state.cycles.find((c) => c.cycle === 1);
    assert.equal(cycle.red.skipped, true);
    assert.ok(cycle.red.reason);
  });

  it('GREEN succeeds when scope has only test files AND one is modified', () => {
    runTaskNext(ws.tasksBase, ws.repoRoot); // skip RED
    fs.writeFileSync(
      path.join(ws.repoRoot, 'src', 'foo.test.js'),
      'const { test } = require("node:test");\ntest("x", () => {});\n'
    );
    const r = runTaskNext(ws.tasksBase, ws.repoRoot);
    assert.equal(r.status, 0, `expected 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout, /GREEN accepted via tests-only/);
    const state = readState(ws.tasksBase);
    assert.equal(state.currentPhase, 'refactor');
    const cycle = state.cycles.find((c) => c.cycle === 1);
    assert.ok(cycle.green);
  });

  it('GREEN blocks when no in-scope test file modified (committed baseline)', () => {
    // Create + COMMIT the test file BEFORE skip-RED so the verifier passes,
    // then ensure no further edits — git diff vs HEAD is empty.
    fs.writeFileSync(
      path.join(ws.repoRoot, 'src', 'foo.test.js'),
      'const { test } = require("node:test");\ntest("x", () => {});\n'
    );
    spawnSync('git', ['add', '.'], { cwd: ws.repoRoot });
    spawnSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: ws.repoRoot });
    runTaskNext(ws.tasksBase, ws.repoRoot); // skip RED
    const r = runTaskNext(ws.tasksBase, ws.repoRoot);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /requires at least one in-scope test file to be modified/);
  });
});

describe('task-next.js — tests-only GREEN refuses non-test scope', () => {
  let ws;
  beforeEach(() => {
    ws = makeWorkspace({ scope: ['src/foo.test.js', 'src/foo.js'] });
    fs.mkdirSync(path.join(ws.repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(ws.repoRoot, 'src', 'foo.test.js'),
      'const { test } = require("node:test");\ntest("x", () => {});\n'
    );
  });
  afterEach(() => {
    if (ws) {
      fs.rmSync(ws.tasksBase, { recursive: true, force: true });
      fs.rmSync(ws.repoRoot, { recursive: true, force: true });
    }
  });

  it('GREEN blocks because scope includes src/foo.js', () => {
    runTaskNext(ws.tasksBase, ws.repoRoot); // skip RED
    const r = runTaskNext(ws.tasksBase, ws.repoRoot);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /ONLY \*\.test\.\* \/ \*\.spec\.\* files/);
  });
});

describe('task-next.js — tests-only GREEN accepts test-constrained glob scope', () => {
  let ws;
  afterEach(() => {
    if (ws) {
      fs.rmSync(ws.tasksBase, { recursive: true, force: true });
      fs.rmSync(ws.repoRoot, { recursive: true, force: true });
    }
  });

  it('GREEN succeeds when scope is a `**\\/*.test.js` glob and an in-scope test was modified', () => {
    ws = makeWorkspace({
      scope: ['src/**/*.test.js'],
      testCmd: 'node --test src/sub/foo.test.js',
    });
    fs.mkdirSync(path.join(ws.repoRoot, 'src', 'sub'), { recursive: true });
    runTaskNext(ws.tasksBase, ws.repoRoot); // skip RED
    fs.writeFileSync(
      path.join(ws.repoRoot, 'src', 'sub', 'foo.test.js'),
      'const { test } = require("node:test");\ntest("x", () => {});\n'
    );
    const r = runTaskNext(ws.tasksBase, ws.repoRoot);
    assert.equal(r.status, 0, `expected 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout, /GREEN accepted via tests-only/);
  });

  it('GREEN succeeds when scope is a `**\\/*.spec.js` glob and an in-scope spec was modified', () => {
    ws = makeWorkspace({
      scope: ['src/foo/**/*.spec.js'],
      testCmd: 'node --test src/foo/sub/bar.spec.js',
    });
    fs.mkdirSync(path.join(ws.repoRoot, 'src', 'foo', 'sub'), { recursive: true });
    runTaskNext(ws.tasksBase, ws.repoRoot); // skip RED
    fs.writeFileSync(
      path.join(ws.repoRoot, 'src', 'foo', 'sub', 'bar.spec.js'),
      'const { test } = require("node:test");\ntest("x", () => {});\n'
    );
    const r = runTaskNext(ws.tasksBase, ws.repoRoot);
    assert.equal(r.status, 0, `expected 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout, /GREEN accepted via tests-only/);
  });

  it('GREEN blocks when scope is an open-ended glob like `src/**` (admits non-tests)', () => {
    ws = makeWorkspace({ scope: ['src/**'] });
    fs.mkdirSync(path.join(ws.repoRoot, 'src'), { recursive: true });
    runTaskNext(ws.tasksBase, ws.repoRoot); // skip RED
    fs.writeFileSync(
      path.join(ws.repoRoot, 'src', 'foo.test.js'),
      'const { test } = require("node:test");\ntest("x", () => {});\n'
    );
    const r = runTaskNext(ws.tasksBase, ws.repoRoot);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /ONLY \*\.test\.\* \/ \*\.spec\.\* files/);
  });
});
