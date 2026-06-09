'use strict';

/**
 * Task 4 — Integration: GREEN docs-exempt fallback in task-next.js.
 *
 * Sibling of Task 3 (RC-D `--docs-exempt` relaxation on `tdd-phase-state.js
 * record-green`). This test exercises the *orchestrator* side: when a task
 * is docs-exempt and the verification command runs silently (RC-D would
 * normally trap it), task-next.js must forward `--docs-exempt` to the
 * recorder so the GREEN phase advances rather than wedging.
 *
 * Scenarios (verbatim from tasks.md):
 *   - docs-exempt task advances RED → GREEN → REFACTOR on a single pass
 *   - non-docs task with a silent verifier still wedges (regression guard)
 *
 * Run with:
 *   node --test scripts/workflows/work-implement/__tests__/task-next-green-docs-exempt.integration.test.js
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
  const repo = makeTmp('green-de-repo-');
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
  const r = spawnSync(
    'node',
    [TDD_CLI, 'init', ticket, '--task', String(taskNum)],
    { cwd, encoding: 'utf8', env: childEnv(tasksBase) }
  );
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
 * tasks.md fixture for a docs-exempt task whose verification command
 * (`true`) exits 0 but emits zero stdout/stderr — the canonical RC-D
 * silent-verifier shape. Scope contains only `.md` entries (no test files)
 * to drive the GREEN docs-exempt fallback.
 */
function writeDocsExemptTasksMd(tasksDir, repo, taskNum) {
  // Create a docs file that initially does NOT contain the marker the
  // verifier greps for — RED verifier exits non-zero (failing as required),
  // then we write the marker and the GREEN verifier exits 0 silently.
  const docsDir = path.join(repo, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'README.md'), 'placeholder\n');
  execSync('git add .', { cwd: repo, stdio: 'pipe' });
  const md = [
    '# Tasks',
    '',
    '## Task ' + taskNum + ' — Docs-only verification fixture',
    '',
    '### Type',
    'docs',
    '',
    '### Description',
    'Docs-only (no R/G/R — documentation exempt). Fixture for GREEN docs-exempt fallback.',
    '',
    '### Files in scope',
    '- docs/README.md',
    '',
    '### Test Command',
    '```bash',
    'grep -q DOCS_MARKER docs/README.md',
    '```',
    '',
    '### Scenarios',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(tasksDir, 'tasks.md'), md);
}

/**
 * tasks.md fixture for a NON-docs task whose verification command also
 * emits zero stdout/stderr (regression: RC-D trap must still fire). Scope
 * is a code file + a test file so neither docs-exempt nor visual-only
 * fallbacks apply.
 */
function writeNonDocsSilentTasksMd(tasksDir, repo, taskNum) {
  const srcDir = path.join(repo, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'feature.js'), '// src\n');
  fs.writeFileSync(
    path.join(srcDir, 'feature.test.js'),
    [
      "const test = require('node:test');",
      "test('non-docs silent', () => { throw new Error('fail'); });",
      '',
    ].join('\n')
  );
  execSync('git add .', { cwd: repo, stdio: 'pipe' });
  const md = [
    '# Tasks',
    '',
    '## Task ' + taskNum + ' — Non-docs silent verifier fixture',
    '',
    '### Type',
    'backend',
    '',
    '### Description',
    'Normal code task. Regression guard for RC-D empty-command trap.',
    '',
    '### Files in scope',
    '- src/feature.js',
    '- src/feature.test.js',
    '',
    '### Test Command',
    '```bash',
    'true',
    '```',
    '',
    '### Scenarios',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(tasksDir, 'tasks.md'), md);
}

describe('task-next.js GREEN docs-exempt fallback', () => {
  let tasksBase;
  let repo;

  beforeEach(() => {
    tasksBase = makeTmp('green-de-tasks-');
    repo = setupGitRepo();
  });

  afterEach(() => {
    fs.rmSync(tasksBase, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('docs-exempt task advances RED → GREEN → REFACTOR on a single pass', () => {
    const TICKET = 'TEST-GDE-1';
    const TASK_NUM = 1;
    fs.mkdirSync(path.join(tasksBase, TICKET), { recursive: true });
    writeDocsExemptTasksMd(path.join(tasksBase, TICKET), repo, TASK_NUM);

    const init = runTddInit(tasksBase, repo, TICKET, TASK_NUM);
    assert.equal(init.exitCode, 0, 'init failed: ' + init.stderr);

    // Invocation 1: RED. Docs-exempt + silent `true` cmd → RED fallback
    // accepts (verification cmd exits 0 but exitCode-!==0 is NOT required
    // for docs-exempt, the existing RED docs-exempt block accepts it).
    // After this, state advances to GREEN.
    const r1 = runTaskNext(tasksBase, repo, TICKET, TASK_NUM);

    // Author the marker that the GREEN verifier greps for (setup mirrors
    // the fixture docstring: "then we write the marker and the GREEN
    // verifier exits 0 silently").
    fs.writeFileSync(
      path.join(repo, 'docs', 'README.md'),
      'placeholder DOCS_MARKER\n'
    );

    // Invocation 2: GREEN. Same silent `true` cmd exits 0. Without the
    // GREEN docs-exempt fallback, recordEvidence forwards no flag and
    // tdd-phase-state.js's RC-D empty-command trap rejects. With the
    // fallback (this task's deliverable), the orchestrator passes
    // `--docs-exempt` and the recorder accepts, advancing to refactor.
    const r2 = runTaskNext(tasksBase, repo, TICKET, TASK_NUM);

    const state = readPhaseState(tasksBase, TICKET, TASK_NUM);
    assert.ok(state, 'tdd-phase.json should exist after the cycle');
    assert.equal(
      state.currentPhase,
      'refactor',
      'docs-exempt task should advance to refactor.\n' +
        'r1 stdout:\n' + r1.stdout + '\nr1 stderr:\n' + r1.stderr +
        '\nr2 stdout:\n' + r2.stdout + '\nr2 stderr:\n' + r2.stderr +
        '\nstate: ' + JSON.stringify(state, null, 2)
    );

    // Diagnostic line must surface the GREEN docs-exempt fallback so the
    // operator sees why a silent verifier was accepted.
    const combined2 = r2.stdout + r2.stderr;
    assert.match(
      combined2,
      /docs-exempt fallback/,
      'GREEN docs-exempt path must emit a diagnostic containing the literal ' +
        '"docs-exempt fallback". Got:\n' + combined2
    );
  });

  it('non-docs task with a silent verifier still wedges (regression guard)', () => {
    const TICKET = 'TEST-GDE-2';
    const TASK_NUM = 1;
    fs.mkdirSync(path.join(tasksBase, TICKET), { recursive: true });
    writeNonDocsSilentTasksMd(path.join(tasksBase, TICKET), repo, TASK_NUM);

    const init = runTddInit(tasksBase, repo, TICKET, TASK_NUM);
    assert.equal(init.exitCode, 0, 'init failed: ' + init.stderr);

    // Seed phase state to green so we exercise the GREEN branch directly
    // (skip the RED dance, which is not the regression surface).
    const statePath = path.join(
      tasksBase, TICKET, 'task' + TASK_NUM, 'tdd-phase.json'
    );
    const state0 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state0.currentPhase = 'green';
    state0.cycles = [
      {
        cycle: 1,
        red: {
          testFiles: ['src/feature.test.js'],
          testCommand: 'true',
          testExitCode: 1,
          timestamp: new Date().toISOString(),
        },
      },
    ];
    fs.writeFileSync(statePath, JSON.stringify(state0, null, 2));

    // Run task-next.js. The verifier (`true`) exits 0 silently. Because
    // the task type is `backend` and scope contains real code, neither
    // isDocsExempt nor isVisualOnlyTask is true — so the GREEN fallback
    // MUST NOT fire. RC-D trap in tdd-phase-state.js should reject.
    const r = runTaskNext(tasksBase, repo, TICKET, TASK_NUM);

    const stateAfter = readPhaseState(tasksBase, TICKET, TASK_NUM);
    assert.equal(
      stateAfter.currentPhase,
      'green',
      'non-docs task with silent verifier must remain wedged at GREEN. ' +
        'stdout:\n' + r.stdout + '\nstderr:\n' + r.stderr +
        '\nstate: ' + JSON.stringify(stateAfter, null, 2)
    );
    assert.notEqual(
      r.exitCode,
      0,
      'non-docs silent verifier should produce a non-zero exit. ' +
        'stdout:\n' + r.stdout + '\nstderr:\n' + r.stderr
    );
    const combined = r.stdout + r.stderr;
    assert.doesNotMatch(
      combined,
      /docs-exempt fallback/,
      'non-docs path must NOT emit the docs-exempt fallback diagnostic. ' +
        'Got:\n' + combined
    );
  });
});
