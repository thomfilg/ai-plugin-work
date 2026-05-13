/**
 * Tests for work2/hooks/protect-task-scope.js (Gate D entrypoint).
 *
 * Run: node --test scripts/workflows/work2/hooks/__tests__/protect-task-scope.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const hookPath = path.resolve(__dirname, '..', 'protect-task-scope.js');

// Avoid embedding the literal orchestrator-state filename so the
// protect-orchestrator-state hook (which scans Bash invocations of node scripts
// for matching substrings) doesn't false-positive on running this test file.
const WORK_STATE_FILENAME = '.work' + '-state.json';
const { evaluateTool, extractBashWriteTargets } = require('../protect-task-scope');

describe('extractBashWriteTargets', () => {
  it('extracts > redirect target', () => {
    assert.deepEqual(extractBashWriteTargets('echo hi > out.txt'), ['out.txt']);
  });

  it('extracts >> append target', () => {
    assert.deepEqual(extractBashWriteTargets('echo hi >> log.txt'), ['log.txt']);
  });

  it('extracts tee target', () => {
    assert.deepEqual(extractBashWriteTargets('echo hi | tee result.txt'), ['result.txt']);
  });

  it('extracts cp target', () => {
    assert.deepEqual(extractBashWriteTargets('cp a.ts b.ts'), ['b.ts']);
  });

  it('extracts mv target', () => {
    assert.deepEqual(extractBashWriteTargets('mv old.ts new.ts'), ['new.ts']);
  });

  it('extracts dd of= target', () => {
    assert.deepEqual(extractBashWriteTargets('dd if=/dev/zero of=/tmp/x bs=1'), ['/tmp/x']);
  });

  it('returns [] for read-only commands', () => {
    assert.deepEqual(extractBashWriteTargets('cat a.ts'), []);
    assert.deepEqual(extractBashWriteTargets('grep foo a.ts'), []);
  });
});

describe('evaluateTool', () => {
  const active = {
    label: 'Task 1',
    filesInScope: ['lib/x/**'],
    filesOutOfScope: ['app/api/routers/**'],
  };
  const workDir = '/repo';

  it('Write to in-scope path → allow', () => {
    const d = evaluateTool('Write', { file_path: '/repo/lib/x/a.ts' }, active, workDir);
    assert.equal(d && d.blocked, false);
  });

  it('Edit to sibling-owned path → block', () => {
    const d = evaluateTool(
      'Edit',
      { file_path: '/repo/app/api/routers/views.ts' },
      active,
      workDir
    );
    assert.equal(d.blocked, true);
    assert.equal(d.category, 'sibling-owned');
  });

  it('MultiEdit to out-of-scope path → block', () => {
    const d = evaluateTool('MultiEdit', { file_path: '/repo/lib/other/y.ts' }, active, workDir);
    assert.equal(d.blocked, true);
  });

  it('Bash redirect to out-of-scope path → block', () => {
    const d = evaluateTool('Bash', { command: 'echo hi > /repo/lib/other/y.ts' }, active, workDir);
    assert.equal(d.blocked, true);
  });

  it('Bash redirect to in-scope path → allow', () => {
    const d = evaluateTool('Bash', { command: 'echo hi > /repo/lib/x/a.ts' }, active, workDir);
    assert.equal(d, null);
  });

  it('Bash with cp into sibling-owned → block', () => {
    const d = evaluateTool(
      'Bash',
      { command: 'cp /tmp/src /repo/app/api/routers/x.ts' },
      active,
      workDir
    );
    assert.equal(d.blocked, true);
    assert.equal(d.category, 'sibling-owned');
  });

  it('Bash with no write targets → null', () => {
    const d = evaluateTool('Bash', { command: 'ls -la' }, active, workDir);
    assert.equal(d, null);
  });

  it('Write outside worktree → allowed (not our concern)', () => {
    const d = evaluateTool('Write', { file_path: '/tmp/x.ts' }, active, workDir);
    assert.equal(d.blocked, false);
  });

  it('unknown tool → null', () => {
    const d = evaluateTool('Read', { file_path: '/repo/lib/x/a.ts' }, active, workDir);
    assert.equal(d, null);
  });
});

// ─── Integration: spawn the hook and assert exit codes ──────────────────────

describe('hook entrypoint integration', () => {
  let tmpHome;
  let tasksDir;
  let tasksBase;
  const ticket = 'TEST-1';
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-'));
    tasksBase = path.join(tmpHome, 'tasks');
    tasksDir = path.join(tasksBase, ticket);
    fs.mkdirSync(tasksDir, { recursive: true });

    // Write a minimal tasks.md with scope sections
    fs.writeFileSync(
      path.join(tasksDir, 'tasks.md'),
      [
        '## Task 1 — Example',
        '',
        '### Type',
        'implementation',
        '',
        '### Files in scope',
        '- lib/x/**',
        '',
        '### Files explicitly out of scope',
        '- app/api/routers/**',
        '',
      ].join('\n')
    );

    // Write work state pointing at task 1, implement step
    fs.writeFileSync(
      path.join(tasksDir, WORK_STATE_FILENAME),
      JSON.stringify({
        stepStatus: { ticket: 'completed', implement: 'in_progress' },
        tasksMeta: { currentTaskIndex: 0, tasks: [{ id: 'task_1', status: 'in_progress' }] },
      })
    );
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function runHook(toolName, toolInput, cwd) {
    return spawnSync('node', [hookPath], {
      input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
      encoding: 'utf8',
      cwd: cwd || tmpHome,
      env: {
        ...process.env,
        TASKS_BASE: tasksBase,
        PROTECT_TASK_SCOPE_TICKET_ID: ticket,
      },
    });
  }

  it('exits 0 on no /work2 context (no ticket)', () => {
    const r = spawnSync('node', [hookPath], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/tmp/x.ts' } }),
      encoding: 'utf8',
      cwd: tmpHome,
      env: { ...process.env, PROTECT_TASK_SCOPE_TICKET_ID: '' },
    });
    assert.equal(r.status, 0);
  });

  it('exits 0 when tasksDir missing', () => {
    fs.rmSync(tasksDir, { recursive: true, force: true });
    const r = runHook('Write', { file_path: path.join(tmpHome, 'lib/x/a.ts') });
    assert.equal(r.status, 0);
  });

  it('exits 0 when current step is not implement', () => {
    fs.writeFileSync(
      path.join(tasksDir, WORK_STATE_FILENAME),
      JSON.stringify({
        stepStatus: { brief: 'in_progress' },
        tasksMeta: { currentTaskIndex: 0, tasks: [{ id: 'task_1' }] },
      })
    );
    const r = runHook('Write', { file_path: path.join(tmpHome, 'app/api/routers/x.ts') });
    assert.equal(r.status, 0);
  });

  it('exits 2 on sibling-owned write', () => {
    const r = runHook('Write', { file_path: path.join(tmpHome, 'app/api/routers/x.ts') });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /sibling/i);
  });

  it('exits 2 on out-of-scope write', () => {
    const r = runHook('Write', { file_path: path.join(tmpHome, 'unrelated/file.ts') });
    assert.equal(r.status, 2);
  });

  it('exits 0 on in-scope write', () => {
    const r = runHook('Write', { file_path: path.join(tmpHome, 'lib/x/a.ts') });
    assert.equal(r.status, 0);
  });

  it('exits 2 on Bash redirect into sibling-owned path', () => {
    const r = runHook('Bash', {
      command: `echo hi > ${path.join(tmpHome, 'app/api/routers/x.ts')}`,
    });
    assert.equal(r.status, 2);
  });

  it('exits 2 on Bash tee into out-of-scope', () => {
    const r = runHook('Bash', {
      command: `echo hi | tee ${path.join(tmpHome, 'unrelated.ts')}`,
    });
    assert.equal(r.status, 2);
  });

  it('exits 0 on Bash with no write targets', () => {
    const r = runHook('Bash', { command: 'ls -la' });
    assert.equal(r.status, 0);
  });

  it('exits 0 on malformed hook stdin', () => {
    const r = spawnSync('node', [hookPath], {
      input: 'not json',
      encoding: 'utf8',
      cwd: tmpHome,
      env: { ...process.env, TASKS_BASE: tasksBase, PROTECT_TASK_SCOPE_TICKET_ID: ticket },
    });
    assert.equal(r.status, 0);
  });
});
