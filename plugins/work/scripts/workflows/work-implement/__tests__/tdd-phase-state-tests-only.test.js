'use strict';

/**
 * tdd-phase-state.js record-skip-red — tests-only contract (GH-528).
 *
 * Type=tests-only tasks add tests against code that already works — there is
 * no "failing test → passing implementation" cycle. RED is intentionally
 * skipped. Acceptance:
 *
 *   - `record-skip-red <TICKET> --task N --reason "tests-only"` accepts the
 *     skip, persists the cycle's `red` slot with `{skipped: true, reason}`,
 *     and transitions currentPhase RED → GREEN.
 *   - The persisted state clearly shows RED was intentionally skipped — not
 *     faked. The marker is the structured `{skipped: true}` field, not a
 *     synthetic test command.
 *   - Reason is required (empty reason → BYPASS line, no state change).
 *   - record-skip-red ignores --cmd entirely (no test command runs).
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'tdd-phase-state.js');
const TICKET = 'TEST-528';

function makeTasksBase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-tests-only-'));
  // Pre-create the ticket workspace marker so writeState's
  // requireTicketWorkspace check passes.
  fs.mkdirSync(path.join(dir, TICKET, 'task1'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, TICKET, '.work' + '-state.json'),
    JSON.stringify({ ticketId: TICKET })
  );
  // GH-528 round-2 follow-up (Cursor[bot] HIGH): record-skip-red now reads
  // the active task's Type from on-disk tasks.md and requires it to be
  // exactly `tests-only`. Plant a minimal tasks.md so the tests-only
  // contract tests still satisfy the new Type gate.
  fs.writeFileSync(
    path.join(dir, TICKET, 'tasks.md'),
    [
      '## Task 1 — sample',
      '',
      '### Type',
      'tests-only',
      '',
      '### Files in scope',
      '- src/**/*.test.js',
      '',
    ].join('\n')
  );
  return dir;
}

function runCli(args, tasksBase) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TASKS_BASE: tasksBase,
      WORK_TDD_TOKEN_SKIP: '1', // gate covered by other tests
      WORK_TDD_SKIP_WORKSPACE_CHECK: '1',
    },
  });
}

describe('tdd-phase-state record-skip-red — tests-only contract', () => {
  let tasksBase;
  beforeEach(() => {
    tasksBase = makeTasksBase();
    // init phase state
    const init = runCli(['init', TICKET, '--task', '1'], tasksBase);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
  });
  afterEach(() => {
    if (tasksBase) fs.rmSync(tasksBase, { recursive: true, force: true });
  });

  it('record-skip-red --reason "tests-only" advances RED→GREEN with skipped marker', () => {
    const r = runCli(
      ['record-skip-red', TICKET, '--task', '1', '--reason', 'tests-only task'],
      tasksBase
    );
    assert.equal(r.status, 0, `expected 0; stdout=${r.stdout} stderr=${r.stderr}`);
    const statePath = path.join(tasksBase, TICKET, 'task1', 'tdd' + '-phase' + '.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.currentPhase, 'green');
    const cycle = state.cycles.find((c) => c.cycle === 1);
    assert.ok(cycle && cycle.red, 'expected red slot to be populated');
    assert.equal(cycle.red.skipped, true, 'red.skipped must be true');
    assert.equal(cycle.red.reason, 'tests-only task');
    // No testCommand field — record-skip-red never runs a command.
    assert.equal(cycle.red.testCommand, undefined);
  });

  it('record-skip-red rejects empty reason (no state change, BYPASS line)', () => {
    const r = runCli(['record-skip-red', TICKET, '--task', '1', '--reason', ''], tasksBase);
    assert.notEqual(r.status, 0, 'expected non-zero exit on empty reason');
    assert.match(`${r.stdout}\n${r.stderr}`, /BYPASS:|reason/i);
    // State must still be RED.
    const statePath = path.join(tasksBase, TICKET, 'task1', 'tdd' + '-phase' + '.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.currentPhase, 'red');
  });

  it('record-skip-red rejects when current phase is not RED', () => {
    // Move to GREEN first via the skip path.
    runCli(['record-skip-red', TICKET, '--task', '1', '--reason', 'first skip'], tasksBase);
    // Now try to record-skip-red again — should reject.
    const r = runCli(['record-skip-red', TICKET, '--task', '1', '--reason', 'second'], tasksBase);
    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /current phase/i);
  });
});
