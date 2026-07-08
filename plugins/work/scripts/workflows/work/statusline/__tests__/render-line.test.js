'use strict';
/**
 * render-line.test.js — unit coverage for the /work status bar composition:
 * current-step resolution, position badge, per-step sub-bars, the budget-based
 * timer colour, and the follow-up hand-off (the bar yields on follow_up and
 * returns on ci).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildLine, isFollowUpActive } = require('../lib/render-line');
const {
  currentStepName,
  stepPosition,
  colorizeElapsed,
  formatElapsedMs,
} = require('../lib/step-meta');
const { detailFor } = require('../lib/step-detail');

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

// All steps completed up to (and excluding) `active`, which is in_progress; the
// rest pending. Mirrors the shape /work persists.
const ORDER = [
  'ticket',
  'bootstrap',
  'brief',
  'brief_gate',
  'spec',
  'spec_gate',
  'tasks',
  'tasks_gate',
  'implement',
  'commit',
  'task_review',
  'check',
  'pr',
  'ready',
  'follow_up',
  'ci',
  'cleanup',
  'reports',
  'complete',
];
function stateAt(active, extra = {}) {
  const stepStatus = {};
  let seenActive = false;
  for (const s of ORDER) {
    if (s === active) {
      stepStatus[s] = 'in_progress';
      seenActive = true;
    } else {
      stepStatus[s] = seenActive ? 'pending' : 'completed';
    }
  }
  return {
    status: 'in_progress',
    stepStatus,
    lastTransitionTimestamp: new Date(0).toISOString(),
    ...extra,
  };
}

describe('step-meta — current step + position', () => {
  it('prefers the in_progress step over the currentStep index', () => {
    const s = stateAt('implement', { currentStep: 99 });
    assert.equal(currentStepName(s), 'implement');
  });

  it('falls back to ALL_STEPS[currentStep - 1] when nothing is in_progress', () => {
    const s = { stepStatus: {}, currentStep: 9 };
    assert.equal(currentStepName(s), 'implement');
  });

  it('counts completed / total for the position badge', () => {
    const { completed, total } = stepPosition(stateAt('implement'));
    assert.equal(total, 19);
    assert.equal(completed, 8); // ticket..tasks_gate
  });
});

describe('step-meta — budget colour', () => {
  it('green at/under budget, yellow up to 2x, red beyond (implement budget 90m)', () => {
    assert.equal(colorizeElapsed('implement', 10 * 60000, 'x'), `${GREEN}x\x1b[0m`);
    assert.equal(colorizeElapsed('implement', 100 * 60000, 'x'), `${YELLOW}x\x1b[0m`);
    assert.equal(colorizeElapsed('implement', 200 * 60000, 'x'), `${RED}x\x1b[0m`);
  });

  it('leaves text uncoloured when elapsed is unknown', () => {
    assert.equal(colorizeElapsed('implement', Number.NaN, 'x'), 'x');
  });

  it('formatElapsedMs renders s / m s / h m and rejects junk', () => {
    assert.equal(formatElapsedMs(5000), '5s');
    assert.equal(formatElapsedMs(90 * 1000), '1m 30s');
    assert.ok(formatElapsedMs(2 * 3600 * 1000).startsWith('2h'));
    assert.equal(formatElapsedMs(Number.NaN), '');
    assert.equal(formatElapsedMs(-1), '');
  });
});

describe('step-detail — per-step sub-bars', () => {
  it('implement → the in_progress task, positioned i/n', () => {
    const s = stateAt('implement', {
      tasksMeta: {
        totalTasks: 7,
        currentTaskIndex: 3,
        tasks: [
          { status: 'completed', title: 'a' },
          { status: 'completed', title: 'b' },
          { status: 'in_progress', title: 'wire the client' },
        ],
      },
    });
    assert.equal(detailFor('implement', s), 'task 3/7: wire the client');
  });

  it('implement → falls back to currentTaskIndex (0-based) when none is in_progress', () => {
    const s = stateAt('implement', {
      tasksMeta: {
        totalTasks: 2,
        currentTaskIndex: 1, // 0-based → the 2nd task
        tasks: [
          { status: 'completed', title: 'a' },
          { status: 'pending', title: 'b' },
        ],
      },
    });
    assert.equal(detailFor('implement', s), 'task 2/2: b');
  });

  it('implement → empty once currentTaskIndex is past the last task', () => {
    const s = stateAt('implement', {
      tasksMeta: {
        totalTasks: 2,
        currentTaskIndex: 2, // 0-based, == length → all tasks done
        tasks: [
          { status: 'completed', title: 'a' },
          { status: 'completed', title: 'b' },
        ],
      },
    });
    assert.equal(detailFor('implement', s), '');
  });

  it('implement → truncates a long title with an ellipsis', () => {
    const long = 'x'.repeat(80);
    const s = stateAt('implement', {
      tasksMeta: { totalTasks: 1, tasks: [{ status: 'in_progress', title: long }] },
    });
    const out = detailFor('implement', s);
    assert.ok(out.endsWith('…'));
    assert.ok(out.length < 60);
  });

  it('check → retry count when the run bounced, else running checks', () => {
    assert.equal(
      detailFor('check', stateAt('check', { checkProgress: { implement: 2 } })),
      'retry 2 (check→implement)'
    );
    assert.equal(detailFor('check', stateAt('check', {})), 'running checks');
  });

  it('task_review → highest fix round, else reviewing tasks', () => {
    const s = stateAt('task_review', {
      tasksMeta: { tasks: [{ taskReviewFixRounds: 0 }, { taskReviewFixRounds: 3 }] },
    });
    assert.equal(detailFor('task_review', s), 'fix round 3');
    assert.equal(detailFor('task_review', stateAt('task_review', {})), 'reviewing tasks');
  });

  it('steps without a renderer get no detail', () => {
    assert.equal(detailFor('pr', stateAt('pr')), '');
    assert.equal(detailFor('spec', stateAt('spec')), '');
  });
});

describe('render-line — follow-up hand-off', () => {
  it('yields (empty line) while on the follow_up step', () => {
    const s = stateAt('follow_up');
    assert.equal(isFollowUpActive(s), true);
    assert.equal(buildLine('FUT-50', s), '');
  });

  it('returns once the run advances to ci', () => {
    const s = stateAt('ci');
    assert.equal(isFollowUpActive(s), false);
    const line = buildLine('FUT-50', s, 60000);
    assert.ok(line.includes('⚙ FUT-50'));
    assert.ok(line.includes('▶ ci'));
  });

  it('empty for a missing/complete state', () => {
    assert.equal(buildLine('FUT-50', null), '');
  });
});

describe('render-line — full composition', () => {
  it('assembles ticket · step(pos) · detail · coloured timer', () => {
    const s = stateAt('implement', {
      tasksMeta: { totalTasks: 7, tasks: [{ status: 'in_progress', title: 'seed db' }] },
    });
    const line = buildLine('FUT-50', s, 10 * 60000); // 10m in → green
    assert.ok(line.includes('⚙ FUT-50'));
    assert.ok(line.includes('▶ implement (8/19)'));
    assert.ok(line.includes('task 1/7: seed db'));
    assert.ok(line.includes(GREEN));
    assert.ok(line.includes('10m'));
  });
});
