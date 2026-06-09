'use strict';

/**
 * protect-task-scope.js — env-bypass gated behind WORK_OPERATOR_TOKEN
 * (GH-528 round-2 follow-up ITEM 1).
 *
 * The bypass env-var pair (PROTECT_TASK_SCOPE_BYPASS_REASON +
 * PROTECT_TASK_SCOPE_BYPASS_TARGET) lets the caller override three guards:
 *   1. filesInScope / decideEdit (out-of-scope writes)
 *   2. per-Type closed-allowlist (tests-only / docs / config / ci)
 *   3. Type-line edit guard (Write/Edit/MultiEdit on tasks.md `### Type` value)
 *
 * Env vars inherit into the agent shell, so without an operator-only token
 * the agent can flip the bypass on. We gate each guard with
 * WORK_OPERATOR_TOKEN === '1' — the same pattern as the `exception`
 * subcommand in tdd-phase-state.js. Without the token, the env pair is
 * treated as unset AND the rejected attempt is audited as
 * `action: 'scope-bypass-rejected'`.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'protect-task-scope.js');
const WORK_STATE_FILENAME = '.work' + '-state.json';
const WORK_ACTIONS_FILENAME = '.work' + '-actions.json';
const TICKET = 'TEST-528';

function readActions(tasksBase) {
  const p = path.join(tasksBase, TICKET, WORK_ACTIONS_FILENAME);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
}

function writeWorkState(tasksDir) {
  fs.writeFileSync(
    path.join(tasksDir, WORK_STATE_FILENAME),
    JSON.stringify({
      ticketId: TICKET,
      stepStatus: { ticket: 'completed', implement: 'in_progress' },
      tasksMeta: { currentTaskIndex: 0, tasks: [{ id: 'task_1', status: 'in_progress' }] },
    })
  );
}

function writeTasksMd(tasksDir, { type, filesInScope }) {
  const lines = [
    '## Task 1 — sample',
    '',
    '### Type',
    type,
    '',
    '### Files in scope',
    ...filesInScope.map((f) => `- ${f}`),
    '',
  ];
  fs.writeFileSync(path.join(tasksDir, 'tasks.md'), lines.join('\n'));
}

function runHook({ tasksBase, cwd, toolName, toolInput, env = {} }) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      TASKS_BASE: tasksBase,
      PROTECT_TASK_SCOPE_TICKET_ID: TICKET,
      // Default — explicitly clear bypass pair AND token. Tests opt in.
      PROTECT_TASK_SCOPE_BYPASS_REASON: '',
      PROTECT_TASK_SCOPE_BYPASS_TARGET: '',
      WORK_OPERATOR_TOKEN: '',
      ...env,
    },
  });
}

// ── Guard 1: filesInScope / decideEdit bypass ──────────────────────────────

describe('protect-task-scope — WORK_OPERATOR_TOKEN gate on filesInScope bypass', () => {
  let tmpHome;
  let tasksBase;
  let tasksDir;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-tok-files-'));
    tasksBase = path.join(tmpHome, 'tasks');
    tasksDir = path.join(tasksBase, TICKET);
    fs.mkdirSync(tasksDir, { recursive: true });
    writeWorkState(tasksDir);
    // tdd-code so the per-Type allowlist guard never fires — isolate the
    // filesInScope guard.
    writeTasksMd(tasksDir, { type: 'tdd-code', filesInScope: ['src/**'] });
  });
  afterEach(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  it('token=1 + pair → bypass fires, audit scope-bypass written', () => {
    const target = path.join(tmpHome, 'lib/foo.js');
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: target, content: 'x' },
      env: {
        WORK_OPERATOR_TOKEN: '1',
        PROTECT_TASK_SCOPE_BYPASS_REASON: 'planned cross-task edit',
        PROTECT_TASK_SCOPE_BYPASS_TARGET: 'lib/foo.js',
      },
    });
    assert.equal(r.status, 0, `expected bypass; stderr=${r.stderr}`);
    const rows = readActions(tasksBase);
    const bypassRows = rows.filter((row) => row && row.action === 'scope-bypass');
    assert.equal(
      bypassRows.length,
      1,
      `expected one scope-bypass row; rows=${JSON.stringify(rows)}`
    );
  });

  it('token unset + pair → bypass IGNORED, blocked, audit scope-bypass-rejected', () => {
    const target = path.join(tmpHome, 'lib/foo.js');
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: target, content: 'x' },
      env: {
        PROTECT_TASK_SCOPE_BYPASS_REASON: 'planned cross-task edit',
        PROTECT_TASK_SCOPE_BYPASS_TARGET: 'lib/foo.js',
        // No WORK_OPERATOR_TOKEN
      },
    });
    assert.equal(r.status, 2, `expected block; stderr=${r.stderr}`);
    const rows = readActions(tasksBase);
    const rejected = rows.filter((row) => row && row.action === 'scope-bypass-rejected');
    assert.equal(
      rejected.length,
      1,
      `expected one scope-bypass-rejected row; rows=${JSON.stringify(rows)}`
    );
    const row = rejected[0];
    assert.equal(row.allow, false, 'rejected row records the block decision');
    assert.equal(
      row.meta && row.meta.configuredTarget,
      'lib/foo.js',
      `rejected row meta records configuredTarget; got ${JSON.stringify(row)}`
    );
    assert.equal(
      row.reason,
      'planned cross-task edit',
      `rejected row records the supplied reason; got ${JSON.stringify(row)}`
    );
    const bypassRows = rows.filter((r2) => r2 && r2.action === 'scope-bypass');
    assert.equal(bypassRows.length, 0, 'no scope-bypass row when token missing');
  });
});

// ── Guard 2: per-Type allowlist bypass ─────────────────────────────────────

describe('protect-task-scope — WORK_OPERATOR_TOKEN gate on per-Type allowlist bypass', () => {
  let tmpHome;
  let tasksBase;
  let tasksDir;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-tok-type-'));
    tasksBase = path.join(tmpHome, 'tasks');
    tasksDir = path.join(tasksBase, TICKET);
    fs.mkdirSync(tasksDir, { recursive: true });
    writeWorkState(tasksDir);
    // docs Type — src/foo.js NOT in docs allowlist, filesInScope **/* makes
    // decideEdit pass, so ONLY the per-Type allowlist guard can block.
    writeTasksMd(tasksDir, { type: 'docs', filesInScope: ['**/*'] });
  });
  afterEach(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  it('token=1 + pair → bypass fires, audit scope-bypass written (guard=type-allowlist)', () => {
    const target = path.join(tmpHome, 'src/foo.js');
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: target, content: 'x' },
      env: {
        WORK_OPERATOR_TOKEN: '1',
        PROTECT_TASK_SCOPE_BYPASS_REASON: 'emergency docs ship',
        PROTECT_TASK_SCOPE_BYPASS_TARGET: 'src/foo.js',
      },
    });
    assert.equal(r.status, 0, `expected bypass; stderr=${r.stderr}`);
    const rows = readActions(tasksBase);
    const bypassRows = rows.filter((row) => row && row.action === 'scope-bypass');
    assert.equal(bypassRows.length, 1);
    assert.equal(bypassRows[0].meta && bypassRows[0].meta.guard, 'type-allowlist');
  });

  it('token unset + pair → bypass IGNORED, blocked, audit scope-bypass-rejected (guard=type-allowlist)', () => {
    const target = path.join(tmpHome, 'src/foo.js');
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: target, content: 'x' },
      env: {
        PROTECT_TASK_SCOPE_BYPASS_REASON: 'emergency docs ship',
        PROTECT_TASK_SCOPE_BYPASS_TARGET: 'src/foo.js',
      },
    });
    assert.equal(r.status, 2, `expected block; stderr=${r.stderr}`);
    const rows = readActions(tasksBase);
    const rejected = rows.filter((row) => row && row.action === 'scope-bypass-rejected');
    assert.equal(
      rejected.length,
      1,
      `expected scope-bypass-rejected; rows=${JSON.stringify(rows)}`
    );
    assert.equal(rejected[0].meta && rejected[0].meta.guard, 'type-allowlist');
    const bypassRows = rows.filter((r2) => r2 && r2.action === 'scope-bypass');
    assert.equal(bypassRows.length, 0);
  });
});

// ── Guard 3: Type-line edit bypass ─────────────────────────────────────────

describe('protect-task-scope — WORK_OPERATOR_TOKEN gate on Type-line bypass', () => {
  let tmpHome;
  let tasksBase;
  let tasksDir;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-tok-tline-'));
    tasksBase = path.join(tmpHome, 'tasks');
    tasksDir = path.join(tasksBase, TICKET);
    fs.mkdirSync(tasksDir, { recursive: true });
    writeWorkState(tasksDir);
    writeTasksMd(tasksDir, {
      type: 'tdd-code',
      filesInScope: ['src/**', 'tasks/**/tasks.md'],
    });
  });
  afterEach(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  it('token=1 + pair → Type-line bypass fires, audit scope-bypass (guard=type-line)', () => {
    const target = path.join(tasksDir, 'tasks.md');
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Edit',
      toolInput: {
        file_path: target,
        old_string: 'tdd-code',
        new_string: 'docs',
      },
      env: {
        WORK_OPERATOR_TOKEN: '1',
        PROTECT_TASK_SCOPE_BYPASS_REASON: 'planner re-keying type mid-cycle',
        PROTECT_TASK_SCOPE_BYPASS_TARGET: path.relative(tmpHome, target),
      },
    });
    assert.equal(r.status, 0, `expected bypass; stderr=${r.stderr}`);
    const rows = readActions(tasksBase);
    const bypassRows = rows.filter((row) => row && row.action === 'scope-bypass');
    assert.equal(bypassRows.length, 1);
    assert.equal(bypassRows[0].meta && bypassRows[0].meta.guard, 'type-line');
  });

  it('token unset + pair → Type-line bypass IGNORED, blocked, audit scope-bypass-rejected (guard=type-line)', () => {
    const target = path.join(tasksDir, 'tasks.md');
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Edit',
      toolInput: {
        file_path: target,
        old_string: 'tdd-code',
        new_string: 'docs',
      },
      env: {
        PROTECT_TASK_SCOPE_BYPASS_REASON: 'planner re-keying type mid-cycle',
        PROTECT_TASK_SCOPE_BYPASS_TARGET: path.relative(tmpHome, target),
      },
    });
    assert.equal(r.status, 2, `expected block; stderr=${r.stderr}`);
    const rows = readActions(tasksBase);
    const rejected = rows.filter((row) => row && row.action === 'scope-bypass-rejected');
    assert.equal(
      rejected.length,
      1,
      `expected scope-bypass-rejected; rows=${JSON.stringify(rows)}`
    );
    assert.equal(rejected[0].meta && rejected[0].meta.guard, 'type-line');
  });
});
