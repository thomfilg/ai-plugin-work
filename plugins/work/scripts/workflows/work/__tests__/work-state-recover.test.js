'use strict';

/**
 * Tests for `work-state.js recover` (GH-753, outcome-verification Phase 1.2).
 *
 * The sanctioned wedge-recovery primitive: consistency-only, operator-approved,
 * fully audited, with a tripwire on repeated recoveries. Replays the GH-736
 * (tasksMeta desync) and GH-721/GH-724 (stuck cycle / unreopenable task)
 * wedge scenarios and asserts they end in a re-attemptable state via the CLI
 * instead of manual state surgery.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLI_PATH = path.join(__dirname, '..', 'work-state.js');
const TEMP_TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'work-state-recover-test-'));
const TICKET = 'TEST-REC-1';

function runWorkState(args = [], extraEnv = {}) {
  return new Promise((resolve) => {
    const proc = spawn('node', [CLI_PATH, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TASKS_BASE: TEMP_TASKS_BASE, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d;
    });
    proc.stderr.on('data', (d) => {
      stderr += d;
    });
    proc.on('close', (code) => {
      let result = null;
      try {
        result = stdout.trim() ? JSON.parse(stdout.trim()) : null;
      } catch {
        /* non-JSON output */
      }
      resolve({ result, stdout, stderr, code });
    });
  });
}

function recover(flags, extraEnv = {}) {
  return runWorkState(['recover', TICKET, ...flags], extraEnv);
}

const APPROVAL = ['--approved-by', 'operator', '--reason', 'wedged - operator approved recovery'];

function ticketDir() {
  return path.join(TEMP_TASKS_BASE, TICKET);
}

function writeState(state) {
  fs.mkdirSync(ticketDir(), { recursive: true });
  fs.writeFileSync(path.join(ticketDir(), '.work-state.json'), JSON.stringify(state, null, 2));
}

function readState() {
  return JSON.parse(fs.readFileSync(path.join(ticketDir(), '.work-state.json'), 'utf8'));
}

function readAudit() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ticketDir(), '.work-actions.json'), 'utf8'));
  } catch {
    return [];
  }
}

function baseState(overrides = {}) {
  return {
    ticketId: TICKET,
    status: 'in_progress',
    tasksMeta: {
      totalTasks: 3,
      currentTaskIndex: 1,
      tasks: [
        { id: 'task_1', status: 'completed', taskReviewFixRounds: 0 },
        { id: 'task_2', status: 'in_progress' },
        { id: 'task_3', status: 'pending' },
      ],
    },
    ...overrides,
  };
}

describe('work-state recover (GH-753)', () => {
  beforeEach(() => {
    fs.rmSync(ticketDir(), { recursive: true, force: true });
  });
  after(() => {
    fs.rmSync(TEMP_TASKS_BASE, { recursive: true, force: true });
  });

  describe('refusal paths', () => {
    it('refuses without operator approval fields', async () => {
      writeState(baseState());
      const r = await recover(['--action', 'abandon-cycle', '--task', '2']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /--approved-by and --reason are mandatory/);
    });

    it('refuses unknown actions and unknown flags', async () => {
      writeState(baseState());
      const bad = await recover(['--action', 'wipe-everything', ...APPROVAL]);
      assert.equal(bad.code, 1);
      assert.match(bad.stderr, /--action must be one of/);

      const flag = await recover(['--frobnicate', 'x', ...APPROVAL]);
      assert.equal(flag.code, 1);
      assert.match(flag.stderr, /unknown argument/);
    });

    it('requires --task for task-scoped actions and bounds it', async () => {
      writeState(baseState());
      const missing = await recover(['--action', 'reopen-task', ...APPROVAL]);
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /--task <n>.*required/);

      const range = await recover(['--action', 'reopen-task', '--task', '9', ...APPROVAL]);
      assert.equal(range.code, 1);
      assert.match(range.stderr, /out of range/);
    });

    it('refuses when no work state exists', async () => {
      const r = await recover(['--action', 'resync-meta', ...APPROVAL]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /no work state found/);
    });
  });

  describe('abandon-cycle (GH-721 stuck-cycle replay)', () => {
    it('clears retry/dispatch state, archives evidence, audits — task is re-attemptable', async () => {
      writeState(
        baseState({
          _tddRetryCount: 34,
          _tddRetryTask: 2,
          _tddRetryReason: 'green never recorded',
          _tddRetryPlannerDefect: true,
          _work2Dispatched: 'implement',
          _preTestForTask: '2',
        })
      );
      const taskDir = path.join(ticketDir(), 'task2');
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        path.join(taskDir, 'tdd-phase.json'),
        JSON.stringify({ currentPhase: 'green', cycles: [{ cycle: 1 }] })
      );

      const r = await recover(['--action', 'abandon-cycle', '--task', '2', ...APPROVAL]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.result.success, true);
      assert.ok(r.result.cleared.includes('_tddRetryCount'));
      assert.ok(r.result.archivedEvidence);

      const state = readState();
      assert.equal(state._tddRetryCount, undefined);
      assert.equal(state._tddRetryPlannerDefect, undefined);
      assert.equal(state._work2Dispatched, undefined);
      assert.equal(state.tasksMeta.tasks[1].status, 'in_progress', 'recovery never mints status');

      assert.ok(!fs.existsSync(path.join(taskDir, 'tdd-phase.json')), 'evidence archived away');
      const archived = fs
        .readdirSync(taskDir)
        .filter((f) => f.startsWith('tdd-phase.json.recovered-'));
      assert.equal(archived.length, 1);

      const rows = readAudit().filter((row) => row.action === 'recover-abandon-cycle');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].allow, true);
      assert.equal(rows[0].meta.approvedBy, 'operator');
      assert.ok(rows[0].meta.before.transientKeys.includes('_tddRetryCount'));
      assert.deepEqual(rows[0].meta.after.transientKeys, []);
    });

    it('refuses on a completed task (points at reopen-task) and no-ops cleanly', async () => {
      writeState(baseState());
      const completed = await recover(['--action', 'abandon-cycle', '--task', '1', ...APPROVAL]);
      assert.equal(completed.code, 1);
      assert.match(completed.stderr, /use --action reopen-task/);

      const noop = await recover(['--action', 'abandon-cycle', '--task', '2', ...APPROVAL]);
      assert.equal(noop.code, 0);
      assert.equal(noop.result.noop, true);
    });
  });

  describe('resync-meta (GH-736 desync replay)', () => {
    const TASKS_MD = [
      '# Tasks',
      '',
      '## Task 1 — First thing',
      '### Type',
      'backend',
      '### Dependencies',
      'None',
      '',
      '## Task 2 — Second thing',
      '### Type',
      'backend',
      '### Dependencies',
      '- Task 1',
      '',
      '## Task 3 — Regenerated third thing',
      '### Type',
      'backend',
      '### Dependencies',
      'None',
      '',
    ].join('\n');

    it('rebuilds tasksMeta from tasks.md preserving completed-by-id', async () => {
      // Stale meta: 5 tasks from a pre-regeneration tasks.md; pointer desynced.
      writeState({
        ticketId: TICKET,
        status: 'in_progress',
        tasksMeta: {
          totalTasks: 5,
          currentTaskIndex: 4,
          tasks: [
            { id: 'task_1', status: 'completed', taskReviewFixRounds: 1, kind: 'tdd-code' },
            { id: 'task_2', status: 'completed', taskReviewFixRounds: 0 },
            { id: 'task_3', status: 'in_progress' },
            { id: 'task_4', status: 'pending' },
            { id: 'task_5', status: 'completed' },
          ],
        },
      });
      fs.writeFileSync(path.join(ticketDir(), 'tasks.md'), TASKS_MD);

      const r = await recover(['--action', 'resync-meta', ...APPROVAL]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.result.totalTasks, 3);
      assert.deepEqual(r.result.preservedCompleted, ['task_1', 'task_2']);

      const meta = readState().tasksMeta;
      assert.equal(meta.tasks.length, 3);
      assert.equal(meta.tasks[0].status, 'completed');
      assert.equal(meta.tasks[0].kind, 'tdd-code', 'kind survives the rebuild');
      assert.equal(meta.tasks[2].status, 'pending', 'in_progress resets to re-attemptable pending');
      assert.equal(meta.currentTaskIndex, 2, 'pointer lands on the first open task');
      assert.deepEqual(meta.tasks[1].dependencies, [1]);
    });

    it('reports a no-op when tasksMeta already matches tasks.md', async () => {
      writeState(baseState());
      fs.writeFileSync(path.join(ticketDir(), 'tasks.md'), TASKS_MD);
      await recover(['--action', 'resync-meta', ...APPROVAL]);
      const again = await recover(['--action', 'resync-meta', ...APPROVAL]);
      assert.equal(again.code, 0);
      assert.equal(again.result.noop, true);
    });

    it('refuses when tasks.md is missing', async () => {
      writeState(baseState());
      const r = await recover(['--action', 'resync-meta', ...APPROVAL]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /no parseable tasks/);
    });
  });

  describe('reopen-task (GH-724 unreopenable-task replay)', () => {
    it('reopens a completed task and repoints the pointer', async () => {
      writeState({
        ticketId: TICKET,
        status: 'in_progress',
        tasksMeta: {
          totalTasks: 3,
          currentTaskIndex: 3,
          tasks: [
            { id: 'task_1', status: 'completed' },
            { id: 'task_2', status: 'completed', taskReviewFixRounds: 2 },
            { id: 'task_3', status: 'completed' },
          ],
        },
      });
      const r = await recover(['--action', 'reopen-task', '--task', '2', ...APPROVAL]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.result.reopened, 'task_2');

      const meta = readState().tasksMeta;
      assert.equal(meta.tasks[1].status, 'pending');
      assert.equal(meta.tasks[1].taskReviewFixRounds, 0);
      assert.equal(meta.currentTaskIndex, 1);
      assert.equal(meta.tasks[2].status, 'completed', 'later tasks untouched');
    });

    it('refuses to reopen a non-completed task', async () => {
      writeState(baseState());
      const r = await recover(['--action', 'reopen-task', '--task', '3', ...APPROVAL]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /only reopens completed tasks/);
    });
  });

  describe('tripwire', () => {
    it('warns loudly past the recovery threshold', async () => {
      writeState(baseState({ _tddRetryCount: 5, _tddRetryTask: 2 }));
      const first = await recover(['--action', 'abandon-cycle', '--task', '2', ...APPROVAL], {
        WORK_RECOVER_TRIPWIRE: '1',
      });
      assert.equal(first.code, 0);
      assert.equal(first.result.tripwire, undefined, 'first recovery under threshold');

      // Re-wedge and recover again — now over the threshold.
      const state = readState();
      state._tddRetryCount = 7;
      state._tddRetryTask = 2;
      writeState(state);
      const second = await recover(['--action', 'abandon-cycle', '--task', '2', ...APPROVAL], {
        WORK_RECOVER_TRIPWIRE: '1',
      });
      assert.equal(second.code, 0);
      assert.ok(second.result.tripwire, 'tripwire fires');
      assert.match(second.stderr, /TRIPWIRE: 2 recoveries/);
      assert.match(second.stderr, /file an issue/);
    });
  });
});
