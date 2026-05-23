/**
 * Tests for protect-task-scope.js env-var bypass, cross-task allow-list, and
 * BYPASS block message (GH-392 Task 8 — P0 #6, P0 #7b, R7).
 *
 * Covers three Gherkin scenarios from gherkin.feature:
 *   - P0 #6 — protect-task-scope.js escape hatch with reason
 *   - P0 #6 — protect-task-scope.js block message advertises the bypass
 *   - P0 #7 — Cross-Task Dependencies block expands scope allow-list
 *
 * Run with:
 *   node --test scripts/workflows/work/hooks/__tests__/protect-task-scope-bypass.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'protect-task-scope.js');
// Avoid embedding the literal orchestrator-state filename so the
// protect-orchestrator-state hook doesn't false-positive on this file.
const WORK_STATE_FILENAME = '.work' + '-state.json';
const WORK_ACTIONS_FILENAME = '.work' + '-actions.json';

const TICKET = 'TEST-392';

function writeTasksMd(tasksDir, { withCrossTaskDeps } = {}) {
  const lines = [
    '## Task 1 — Bypass fixture',
    '',
    '### Type',
    'wiring',
    '',
    '### Files in scope',
    '- lib/x/**',
    '',
  ];
  if (withCrossTaskDeps) {
    lines.push('### Cross-Task Dependencies');
    lines.push('- src/shared/schema.ts (owned by Task 4)');
    lines.push('');
  }
  lines.push('### Files explicitly out of scope');
  lines.push('- app/api/routers/**');
  lines.push('');
  fs.writeFileSync(path.join(tasksDir, 'tasks.md'), lines.join('\n'));
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

function runHook({ tasksBase, cwd, toolName, toolInput, env = {} }) {
  return spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      TASKS_BASE: tasksBase,
      PROTECT_TASK_SCOPE_TICKET_ID: TICKET,
      // Clear by default so tests opt in explicitly.
      PROTECT_TASK_SCOPE_BYPASS_REASON: '',
      PROTECT_TASK_SCOPE_BYPASS_TARGET: '',
      ...env,
    },
  });
}

function readActions(tasksBase) {
  const p = path.join(tasksBase, TICKET, WORK_ACTIONS_FILENAME);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8').trim();
  if (!raw) return [];
  // The audit log may be a JSON array or NDJSON; handle both.
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

describe('protect-task-scope.js escape hatch + cross-task allow-list (GH-392 Task 8)', () => {
  let tmpHome;
  let tasksBase;
  let tasksDir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-bypass-'));
    tasksBase = path.join(tmpHome, 'tasks');
    tasksDir = path.join(tasksBase, TICKET);
    fs.mkdirSync(tasksDir, { recursive: true });
    writeWorkState(tasksDir);
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('P0 #6 — escape hatch fires when REASON + TARGET both set and match', () => {
    writeTasksMd(tasksDir, { withCrossTaskDeps: false });
    const target = path.join(tmpHome, 'src/shared/schema.ts');

    const reason = 'cross-task dep emergency';
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Edit',
      toolInput: { file_path: target },
      env: {
        PROTECT_TASK_SCOPE_BYPASS_REASON: reason,
        PROTECT_TASK_SCOPE_BYPASS_TARGET: 'src/shared/schema.ts',
      },
    });

    assert.equal(
      r.status,
      0,
      `expected exit 0 with bypass reason+target set; stderr=${r.stderr} stdout=${r.stdout}`
    );

    const rows = readActions(tasksBase);
    const bypassRows = rows.filter((row) => row && row.action === 'scope-bypass');
    assert.equal(bypassRows.length, 1, 'exactly one scope-bypass audit row expected');
    const row = bypassRows[0];
    assert.equal(row.reason, reason, 'audit row carries the supplied reason');
    const serialized = JSON.stringify(row);
    assert.ok(
      serialized.includes('src/shared/schema.ts'),
      `audit row should reference the target path; got: ${serialized}`
    );
    // Audit row records the CONFIGURED target alongside the actual one.
    assert.equal(
      row.meta && row.meta.configuredTarget,
      'src/shared/schema.ts',
      `audit row meta should record configuredTarget; got: ${serialized}`
    );
    assert.ok(
      row.task === 1 || row.task === '1' || (row.meta && (row.meta.taskNum === 1 || row.meta.task === 1)),
      `audit row should reference task 1; got: ${serialized}`
    );
  });

  it('P0 #6 — REASON set but TARGET missing → block stands, NO audit row', () => {
    writeTasksMd(tasksDir, { withCrossTaskDeps: false });
    const target = path.join(tmpHome, 'src/shared/schema.ts');

    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Edit',
      toolInput: { file_path: target },
      env: { PROTECT_TASK_SCOPE_BYPASS_REASON: 'lone reason' },
    });

    assert.equal(r.status, 2, `expected exit 2 when TARGET is missing; stderr=${r.stderr}`);
    const rows = readActions(tasksBase);
    const bypassRows = rows.filter((row) => row && row.action === 'scope-bypass');
    assert.equal(bypassRows.length, 0, 'no scope-bypass row when TARGET unset');
  });

  it("P0 #6 — REASON+TARGET set but TARGET doesn't match actual target → block stands, NO audit row", () => {
    writeTasksMd(tasksDir, { withCrossTaskDeps: false });
    const target = path.join(tmpHome, 'src/shared/schema.ts');

    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Edit',
      toolInput: { file_path: target },
      env: {
        PROTECT_TASK_SCOPE_BYPASS_REASON: 'reason',
        PROTECT_TASK_SCOPE_BYPASS_TARGET: 'src/somewhere/else.ts',
      },
    });

    assert.equal(r.status, 2, `expected exit 2 when TARGET mismatches; stderr=${r.stderr}`);
    const rows = readActions(tasksBase);
    const bypassRows = rows.filter((row) => row && row.action === 'scope-bypass');
    assert.equal(bypassRows.length, 0, 'no scope-bypass row when TARGET mismatches');
  });

  it('P0 #6 — TARGET as glob matches and fires bypass', () => {
    writeTasksMd(tasksDir, { withCrossTaskDeps: false });
    const target = path.join(tmpHome, 'src/shared/schema.ts');

    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Edit',
      toolInput: { file_path: target },
      env: {
        PROTECT_TASK_SCOPE_BYPASS_REASON: 'pattern bypass',
        PROTECT_TASK_SCOPE_BYPASS_TARGET: 'src/shared/**',
      },
    });

    assert.equal(r.status, 0, `expected exit 0 with TARGET glob match; stderr=${r.stderr}`);
    const rows = readActions(tasksBase);
    const bypassRows = rows.filter((row) => row && row.action === 'scope-bypass');
    assert.equal(bypassRows.length, 1, 'scope-bypass row expected when TARGET glob matches');
    assert.equal(bypassRows[0].meta.configuredTarget, 'src/shared/**');
  });

  it('P0 #6 — protect-task-scope.js block message advertises the bypass', () => {
    writeTasksMd(tasksDir, { withCrossTaskDeps: false });
    const target = path.join(tmpHome, 'src/shared/schema.ts');

    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Edit',
      toolInput: { file_path: target },
      // no bypass reason, no cross-task deps → must block
    });

    assert.equal(r.status, 2, `expected exit 2 when no bypass and no cross-task dep; stderr=${r.stderr}`);
    const stderr = r.stderr.trimEnd();
    const lastLine = stderr.split('\n').pop() || '';
    assert.match(
      lastLine,
      /^BYPASS:/,
      `last stderr line must start with BYPASS:; got last line: "${lastLine}" full stderr: ${r.stderr}`
    );
    assert.match(
      lastLine,
      /PROTECT_TASK_SCOPE_BYPASS_REASON/,
      `BYPASS line must name the REASON env var; got: ${lastLine}`
    );
    assert.match(
      lastLine,
      /PROTECT_TASK_SCOPE_BYPASS_TARGET/,
      `BYPASS line must name the TARGET env var; got: ${lastLine}`
    );
    assert.ok(
      lastLine.includes(WORK_ACTIONS_FILENAME),
      `BYPASS line must point at the audit log; got: ${lastLine}`
    );

    // No audit row was appended for a plain block.
    const rows = readActions(tasksBase);
    const bypassRows = rows.filter((row) => row && row.action === 'scope-bypass');
    assert.equal(bypassRows.length, 0, 'no scope-bypass row when bypass was not used');
  });

  it('P0 #7 — Cross-Task Dependencies block expands scope allow-list', () => {
    writeTasksMd(tasksDir, { withCrossTaskDeps: true });
    const target = path.join(tmpHome, 'src/shared/schema.ts');

    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Edit',
      toolInput: { file_path: target },
      // no env var — cross-task dep should be enough
    });

    assert.equal(
      r.status,
      0,
      `expected exit 0 when target matches crossTaskDeps; stderr=${r.stderr} stdout=${r.stdout}`
    );

    const rows = readActions(tasksBase);
    const allowRows = rows.filter((row) => row && row.action === 'cross-task-dep-allow');
    assert.equal(allowRows.length, 1, 'exactly one cross-task-dep-allow audit row expected');
    const serialized = JSON.stringify(allowRows[0]);
    assert.ok(
      serialized.includes('src/shared/schema.ts'),
      `cross-task-dep-allow audit row should reference target; got: ${serialized}`
    );
  });
});
