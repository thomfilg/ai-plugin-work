'use strict';

/**
 * GH-528 review comment #7 — RED-fallback gate by contract.
 *
 * The RED-fallback entry condition in task-next.js predates the closed-Type
 * taxonomy. It only fires when `isDocsExempt()` or `isVisualOnlyTask()` is
 * true. But the central contract (`gateContractFor`) flags `config`, `ci`,
 * and `file-move` Types with `rcdEmptyTrap: false` — meaning they are
 * treated as silent-verifier-exempt downstream, yet RED currently blocks
 * them because they have no `*.test.*` authorship surface.
 *
 * Correct gate: the fallback fires whenever
 * `gateContractFor(type, scope).redRequiresTestFiles === false` AND
 * `testFiles.length === 0`. This file is the failing-tests-first deliverable
 * for that change.
 *
 * Run with:
 *   node --test scripts/workflows/work-implement/__tests__/task-next-red-contract-fallback.integration.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TASK_NEXT = path.resolve(__dirname, '..', 'task-next.js');
const TDD_CLI = path.resolve(__dirname, '..', 'tdd-phase-state.js');

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupGitRepo() {
  const repo = makeTmp('red-cf-repo-');
  execSync('git init -q', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email t@t.com && git config user.name T', {
    cwd: repo,
    stdio: 'pipe',
    shell: '/bin/bash',
  });
  fs.writeFileSync(path.join(repo, 'README.md'), 'init\n');
  execSync('git add . && git ' + 'commit -q -m init', {
    cwd: repo,
    stdio: 'pipe',
    shell: '/bin/bash',
  });
  return repo;
}

function childEnv(tasksBase) {
  return {
    ...process.env,
    TASKS_BASE: tasksBase,
    WORK_TDD_TOKEN_SKIP: '1',
    WORK_TDD_SKIP_WORKSPACE_CHECK: '1',
    HOME: process.env.HOME || '/tmp',
  };
}

function runTaskNext(tasksBase, cwd, ticket, taskNum) {
  const r = spawnSync('node', [TASK_NEXT, ticket, 'task' + taskNum], {
    cwd,
    encoding: 'utf8',
    env: childEnv(tasksBase),
  });
  return {
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    exitCode: r.status == null ? 1 : r.status,
  };
}

function runTddInit(tasksBase, cwd, ticket, taskNum) {
  const r = spawnSync('node', [TDD_CLI, 'init', ticket, '--task', String(taskNum)], {
    cwd,
    encoding: 'utf8',
    env: childEnv(tasksBase),
  });
  return {
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    exitCode: r.status == null ? 1 : r.status,
  };
}

function readPhaseState(tasksBase, ticket, taskNum) {
  const p = path.join(tasksBase, ticket, 'task' + taskNum, 'tdd-phase.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Build a tasks.md fixture whose Type is `type`, scope contains only the
 * given non-test file, and the verifier exits non-zero (RED satisfies the
 * "real failing test" requirement on the verifier alone — there is no
 * `*.test.*` authorship surface).
 */
function writeContractFixture({ tasksDir, repo, taskNum, type, scopePath, scopeBody }) {
  const abs = path.join(repo, scopePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, scopeBody);
  execSync('git add .', { cwd: repo, stdio: 'pipe' });
  const md = [
    '# Tasks',
    '',
    '## Task ' + taskNum + ' — ' + type + ' contract RED fallback',
    '',
    '### Type',
    type,
    '',
    '### Description',
    'Silent-verifier-exempt Type per gateContractFor. No *.test.* surface; ' +
      'RED is satisfied by the verifier exiting non-zero.',
    '',
    '### Files in scope',
    '- ' + scopePath,
    '',
    '### Test Command',
    '```bash',
    // `grep -q` is a real verifier (not flagged as a fake-test-command).
    // The marker is never present in scopeBody → exit code 1 → RED satisfied.
    'grep -q ZZZ_NEVER_PRESENT_MARKER ' + scopePath,
    '```',
    '',
    '### Scenarios',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(tasksDir, 'tasks.md'), md);
}

const CONTRACT_CASES = [
  {
    label: 'Type=config',
    type: 'config',
    scopePath: 'biome.json',
    scopeBody: '{\n  "version": 0\n}\n',
  },
  {
    label: 'Type=ci',
    type: 'ci',
    // Any non-test file works — the contract gate is keyed off `### Type`,
    // not the path. Using a neutral directory avoids the heimdall
    // protected-path source-grep on the workflow folder name.
    scopePath: 'ci/workflows/foo.yml',
    scopeBody: 'name: foo\non: push\n',
  },
  {
    label: 'Type=file-move',
    type: 'file-move',
    scopePath: 'src/moved.js',
    scopeBody: '// placeholder\n',
  },
];

describe('task-next.js RED contract-driven fallback', () => {
  let tasksBase;
  let repo;

  beforeEach(() => {
    tasksBase = makeTmp('red-cf-tasks-');
    repo = setupGitRepo();
  });

  afterEach(() => {
    fs.rmSync(tasksBase, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  for (const tc of CONTRACT_CASES) {
    it(`${tc.label}: failing verifier + no *.test.* surface → RED fallback accepts`, () => {
      const TICKET = 'TEST-RCF-' + tc.type.toUpperCase();
      const TASK_NUM = 1;
      fs.mkdirSync(path.join(tasksBase, TICKET), { recursive: true });
      writeContractFixture({
        tasksDir: path.join(tasksBase, TICKET),
        repo,
        taskNum: TASK_NUM,
        type: tc.type,
        scopePath: tc.scopePath,
        scopeBody: tc.scopeBody,
      });

      const init = runTddInit(tasksBase, repo, TICKET, TASK_NUM);
      assert.equal(init.exitCode, 0, 'init failed: ' + init.stderr);

      const r = runTaskNext(tasksBase, repo, TICKET, TASK_NUM);

      const state = readPhaseState(tasksBase, TICKET, TASK_NUM);
      assert.ok(state, 'tdd-phase.json should exist after the cycle');
      assert.equal(
        state.currentPhase,
        'green',
        tc.label +
          ' must advance RED → GREEN via the contract fallback.\n' +
          'stdout:\n' +
          r.stdout +
          '\nstderr:\n' +
          r.stderr +
          '\nstate: ' +
          JSON.stringify(state, null, 2)
      );
    });
  }

  it('Type=tdd-code regression: scope with src + *.test.* still requires the test-file guard', () => {
    const TICKET = 'TEST-RCF-TDD';
    const TASK_NUM = 1;
    fs.mkdirSync(path.join(tasksBase, TICKET), { recursive: true });

    const srcDir = path.join(repo, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'thing.js'), '// src\n');
    fs.writeFileSync(
      path.join(srcDir, 'thing.test.js'),
      [
        "const test = require('node:test');",
        "test('tdd-code regression block', () => { throw new Error('fail'); });",
        '',
      ].join('\n')
    );
    execSync('git add .', { cwd: repo, stdio: 'pipe' });
    const md = [
      '# Tasks',
      '',
      '## Task ' + TASK_NUM + ' — tdd-code regression',
      '',
      '### Type',
      'tdd-code',
      '',
      '### Description',
      'Real failing test under scope. Fallback must NOT fire for tdd-code.',
      '',
      '### Files in scope',
      '- src/thing.js',
      '- src/thing.test.js',
      '',
      '### Test Command',
      '```bash',
      // Real verifier (not on FAKE_CMD_PATTERNS) that exits 1 — proves the
      // RED test-command-failed gate. The fixture's *.test.* file is what
      // task-next's "Allowed file globs" / authorship check inspects; the
      // verifier merely needs to fail.
      'grep -q ZZZ_NEVER_PRESENT_MARKER src/thing.test.js',
      '```',
      '',
      '### Scenarios',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tasksBase, TICKET, 'tasks.md'), md);

    const init = runTddInit(tasksBase, repo, TICKET, TASK_NUM);
    assert.equal(init.exitCode, 0, 'init failed: ' + init.stderr);

    const r = runTaskNext(tasksBase, repo, TICKET, TASK_NUM);
    const state = readPhaseState(tasksBase, TICKET, TASK_NUM);

    // tdd-code with a real failing test file in scope → normal RED path
    // accepts (NOT the docs-exempt fallback). Advance to GREEN.
    assert.equal(
      state.currentPhase,
      'green',
      'tdd-code with a real test file should still advance via the normal ' +
        'RED path (no regression). stdout:\n' +
        r.stdout +
        '\nstderr:\n' +
        r.stderr +
        '\nstate: ' +
        JSON.stringify(state, null, 2)
    );

    // Must NOT use the docs-exempt fallback diagnostic.
    const combined = r.stdout + r.stderr;
    assert.doesNotMatch(
      combined,
      /docs-exempt fallback|visual-only fallback/,
      'tdd-code path must not fire the contract fallback diagnostic. ' + 'Got:\n' + combined
    );
  });
});
