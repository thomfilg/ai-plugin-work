'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { main, aggregate } = require('../sli-report');
const { analyzeTicket, DEFAULT_WEDGE_THRESHOLD } = require('../scan');

let BASE;

beforeEach(() => {
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'sli-report-test-'));
});
afterEach(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
});

function makeTicket(name, { actions, state }) {
  const dir = path.join(BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  if (actions !== undefined) {
    const payload = typeof actions === 'string' ? actions : JSON.stringify(actions);
    fs.writeFileSync(path.join(dir, '.work-actions.json'), payload);
  }
  if (state !== undefined) {
    const payload = typeof state === 'string' ? state : JSON.stringify(state);
    fs.writeFileSync(path.join(dir, '.work-state.json'), payload);
  }
  return dir;
}

function sink() {
  return {
    buf: '',
    write(s) {
      this.buf += s;
    },
  };
}

function run(argv, env = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = main(argv, { TASKS_BASE: BASE, ...env }, stdout, stderr);
  return { code, out: stdout.buf, err: stderr.buf };
}

const T0 = '2026-07-01T10:00:00.000Z';
const T10 = '2026-07-01T10:10:00.000Z';
const T20 = '2026-07-01T10:20:00.000Z';

function tasksMeta(statuses, currentTaskIndex = 0, fixRounds = {}) {
  return {
    tasks: statuses.map((status, i) => ({
      id: `task_${i + 1}`,
      status,
      taskReviewFixRounds: fixRounds[i + 1] || 0,
    })),
    currentTaskIndex,
    totalTasks: statuses.length,
  };
}

describe('sli-report — wedge proxies', () => {
  it('W1: state retries + gate rejections use max() and respect the threshold', () => {
    makeTicket('TEST-W1', {
      actions: [
        { step: 'implement', timestamp: T0, what: 'step started' },
        {
          kind: 'enforcement',
          timestamp: T0,
          origin: 'workflow',
          task: 2,
          phase: 'green',
          action: 'tdd-green-empty-rejected',
          allow: false,
          reason: 'empty-output-exit-0',
        },
        {
          kind: 'enforcement',
          timestamp: T10,
          origin: 'workflow',
          task: 2,
          phase: 'green',
          action: 'tdd-green-empty-rejected',
          allow: false,
          reason: 'empty-output-exit-0',
        },
        { step: 'implement', timestamp: T10, what: 'step completed' },
        { kind: 'usage', timestamp: T10, step: 'implement', agentType: 'x', totalTokens: 1 },
      ],
      state: {
        tasksMeta: tasksMeta(['completed', 'in_progress', 'pending'], 1),
        _tddRetryCount: 5,
        _tddRetryTask: 2,
      },
    });
    const r = analyzeTicket(BASE, 'TEST-W1', { wedgeThreshold: DEFAULT_WEDGE_THRESHOLD });
    assert.equal(r.knownTasks, 3);
    // max(gateRejections=2, stateRetries=5) = 5 > 3 → wedged
    assert.deepEqual(r.wedgedTasks, [2]);
    assert.equal(r.retriesTotal, 5);
    assert.equal(r.timeInImplementMs, 10 * 60 * 1000);
    assert.equal(r.dispatches.implement, 1);
  });

  it('W2: an escalation row wedges the named task', () => {
    makeTicket('TEST-W2', {
      actions: [
        {
          step: 'task_review',
          timestamp: T0,
          what: 'task 2/3 fix rounds exhausted (3/3) -- escalating',
        },
      ],
      state: { tasksMeta: tasksMeta(['completed', 'in_progress', 'pending'], 1) },
    });
    const r = analyzeTicket(BASE, 'TEST-W2', { wedgeThreshold: DEFAULT_WEDGE_THRESHOLD });
    assert.deepEqual(r.wedgedTasks, [2]);
  });

  it('W3: recovery enforcement rows wedge; unattributed ones attach to the current task', () => {
    makeTicket('TEST-W3', {
      actions: [
        {
          kind: 'enforcement',
          timestamp: T0,
          origin: 'user',
          task: null,
          phase: null,
          action: 'recover-reopen-task',
          allow: true,
          reason: 'operator recovery',
        },
      ],
      state: { tasksMeta: tasksMeta(['completed', 'in_progress'], 1) },
    });
    const r = analyzeTicket(BASE, 'TEST-W3', { wedgeThreshold: DEFAULT_WEDGE_THRESHOLD });
    assert.deepEqual(r.wedgedTasks, [2]);
    assert.equal(r.unattributedRecoveries, 0);
  });

  it('W4: a parked planner hold wedges the retry task', () => {
    makeTicket('TEST-W4', {
      actions: [],
      state: {
        tasksMeta: tasksMeta(['in_progress'], 0),
        _tddRetryTask: 1,
        _tddRetryPlannerDefect: true,
      },
    });
    const r = analyzeTicket(BASE, 'TEST-W4', { wedgeThreshold: DEFAULT_WEDGE_THRESHOLD });
    assert.deepEqual(r.wedgedTasks, [1]);
  });
});

describe('sli-report — escape proxies', () => {
  it('E1+E2: review-failure rows attribute to the nearest preceding scheduled task', () => {
    makeTicket('TEST-E1', {
      actions: [
        { step: 'task_review', timestamp: T0, what: 'task 1/2 review scheduled for "a"' },
        { step: 'task_review', timestamp: T10, what: 'task review failed: assertions too weak' },
        { step: 'task_review', timestamp: T20, what: 'task review passed (tests + code)' },
      ],
      state: { tasksMeta: tasksMeta(['completed', 'pending'], 1) },
    });
    const r = analyzeTicket(BASE, 'TEST-E1', { wedgeThreshold: DEFAULT_WEDGE_THRESHOLD });
    assert.deepEqual(r.escapedTasks, [1]);
    assert.deepEqual(r.advancedTasks, [1]);
    assert.equal(r.escapeRate, 1);
  });

  it('E2: taskReviewFixRounds > 0 marks a completed task escaped', () => {
    makeTicket('TEST-E2', {
      actions: [],
      state: { tasksMeta: tasksMeta(['completed'], 0, { 1: 2 }) },
    });
    const r = analyzeTicket(BASE, 'TEST-E2', { wedgeThreshold: DEFAULT_WEDGE_THRESHOLD });
    assert.deepEqual(r.escapedTasks, [1]);
  });

  it('E3: implement re-entries count at ticket level and mark escape tickets', () => {
    makeTicket('TEST-E3', {
      actions: [
        { step: 'implement', timestamp: T0, what: 'step started' },
        { step: 'implement', timestamp: T10, what: 'step completed' },
        { step: 'implement', timestamp: T20, what: 'step started' },
      ],
      state: { tasksMeta: tasksMeta(['completed'], 0) },
    });
    const r = analyzeTicket(BASE, 'TEST-E3', { wedgeThreshold: DEFAULT_WEDGE_THRESHOLD });
    assert.equal(r.implementReentries, 1);
    const agg = aggregate([r]);
    assert.equal(agg.ticketsWithEscape, 1);
    assert.equal(agg.implementReentriesTotal, 1);
  });
});

describe('sli-report — robustness and CLI', () => {
  it('malformed inputs degrade to warnings, exit 0', () => {
    makeTicket('TEST-BAD', { actions: '{nope', state: '[]' });
    const { code, out, err } = run([]);
    assert.equal(code, 0);
    assert.match(err, /TEST-BAD: malformed \.work-actions\.json/);
    assert.match(err, /TEST-BAD: \.work-state\.json is not a JSON object/);
    assert.match(out, /no analyzable tickets/);
  });

  it('empty dirs are skipped with a warning', () => {
    fs.mkdirSync(path.join(BASE, 'TEST-EMPTY'));
    const { code, err } = run([]);
    assert.equal(code, 0);
    assert.match(err, /TEST-EMPTY: no \.work-actions\.json or \.work-state\.json — skipped/);
  });

  it('--json emits a parseable document with aggregate SLIs', () => {
    makeTicket('TEST-J', {
      actions: [],
      state: { tasksMeta: tasksMeta(['completed', 'pending'], 1, { 1: 1 }) },
    });
    const { code, out } = run(['--json']);
    assert.equal(code, 0);
    const doc = JSON.parse(out);
    assert.equal(doc.aggregate.tickets, 1);
    assert.equal(doc.aggregate.tasksEscaped, 1);
    assert.equal(doc.wedgeThreshold, DEFAULT_WEDGE_THRESHOLD);
  });

  it('positional tickets restrict the report; table renders', () => {
    makeTicket('TEST-A', { actions: [], state: { tasksMeta: tasksMeta(['completed'], 0) } });
    makeTicket('TEST-B', { actions: [], state: { tasksMeta: tasksMeta(['completed'], 0) } });
    const { code, out } = run(['TEST-A']);
    assert.equal(code, 0);
    assert.match(out, /TEST-A/);
    assert.doesNotMatch(out, /TEST-B/);
    assert.match(out, /aggregate: 1 ticket\(s\)/);
  });

  it('--wedge-threshold 0 makes a single retry a wedge', () => {
    makeTicket('TEST-T0', {
      actions: [],
      state: { tasksMeta: tasksMeta(['in_progress'], 0), _tddRetryCount: 1, _tddRetryTask: 1 },
    });
    const { code, out } = run(['--wedge-threshold', '0', 'TEST-T0']);
    assert.equal(code, 0);
    assert.match(out, /wedge rate 100\.0%/);
  });

  it('flag errors and missing base exit 1; --help exits 0 with heuristics', () => {
    assert.equal(run(['--bogus']).code, 1);
    assert.equal(run(['--wedge-threshold', '-1']).code, 1);
    assert.equal(run(['--tasks-base']).code, 1);
    const noBase = main([], {}, sink(), sink());
    assert.equal(noBase, 1);
    const help = run(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /Measurement heuristics/);
    const missingDir = run(['--tasks-base', path.join(BASE, 'absent')]);
    assert.equal(missingDir.code, 1);
  });
});
