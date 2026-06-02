/**
 * Tests for task-readiness.initTasksMeta `kind` persistence (GH-410 Task 1).
 *
 * Uses node:test + node:assert/strict. Drives `initTasksMeta` via the
 * `work-state.js` parent module so the parent function injection
 * (loadState/saveState/initState) is wired up the same way production uses it.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEMP_TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'task-readiness-test-'));
process.env.TASKS_BASE = TEMP_TASKS_BASE;

// Require parent first so it sets up _setParent on task-readiness.
const workState = require('../work-state');
const { initTasksMeta } = require('../work-state/task-readiness');

after(() => {
  try {
    fs.rmSync(TEMP_TASKS_BASE, { recursive: true, force: true });
  } catch {}
});

function freshTicket(prefix) {
  const id = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  workState.initState(id);
  return id;
}

describe('initTasksMeta — kind persistence (GH-410)', () => {
  it('persists `kind` from descriptor `type` verbatim for every taxonomy kind', () => {
    const ticket = freshTicket('GH-410-KIND-ALL');
    const descriptors = [
      { num: 1, type: 'frontend' },
      { num: 2, type: 'checkpoint' },
      { num: 3, type: 'backend' },
      { num: 4, type: 'e2e' },
      { num: 5, type: 'devops' },
      { num: 6, type: 'wiring' },
      { num: 7, type: 'fullstack' },
    ];

    const result = initTasksMeta(ticket, descriptors);
    assert.ok(result.success, `initTasksMeta should succeed, got: ${JSON.stringify(result)}`);

    const tasks = result.tasksMeta.tasks;
    assert.equal(tasks.length, 7);

    // Each entry's kind should equal the descriptor type verbatim.
    assert.equal(tasks[0].kind, 'frontend');
    assert.equal(tasks[1].kind, 'checkpoint');
    assert.equal(tasks[2].kind, 'backend');
    assert.equal(tasks[3].kind, 'e2e');
    assert.equal(tasks[4].kind, 'devops');
    assert.equal(tasks[5].kind, 'wiring');
    assert.equal(tasks[6].kind, 'fullstack');

    // Existing fields preserved.
    assert.equal(tasks[1].id, 'task_2');
    assert.equal(tasks[1].status, 'pending');
    assert.deepEqual(tasks[1].dependencies, []);
  });

  it('omits `kind` when descriptor lacks `type` (legacy descriptor array)', () => {
    const ticket = freshTicket('GH-410-KIND-NONE');
    const descriptors = [
      { num: 1 },
      { num: 2 },
    ];

    const result = initTasksMeta(ticket, descriptors);
    assert.ok(result.success);

    const tasks = result.tasksMeta.tasks;
    assert.equal(tasks.length, 2);
    assert.equal(
      Object.prototype.hasOwnProperty.call(tasks[0], 'kind'),
      false,
      'tasks[0] must NOT carry a `kind` field when descriptor has no `type`',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(tasks[1], 'kind'),
      false,
      'tasks[1] must NOT carry a `kind` field when descriptor has no `type`',
    );
    assert.equal(tasks[0].kind, undefined);
    assert.equal(tasks[1].kind, undefined);
  });

  it('legacy count-only invocation produces entries with no `kind` field', () => {
    const ticket = freshTicket('GH-410-KIND-COUNT');
    const result = initTasksMeta(ticket, 3);
    assert.ok(result.success);

    const tasks = result.tasksMeta.tasks;
    assert.equal(tasks.length, 3);
    for (const t of tasks) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(t, 'kind'),
        false,
        `legacy count-only entry ${t.id} must NOT carry a kind field`,
      );
    }
  });

  it('preserves dependencies alongside kind', () => {
    const ticket = freshTicket('GH-410-KIND-DEPS');
    const descriptors = [
      { num: 1, type: 'backend', dependencies: [] },
      { num: 2, type: 'checkpoint', dependencies: [1] },
    ];

    const result = initTasksMeta(ticket, descriptors);
    assert.ok(result.success);

    assert.equal(result.tasksMeta.tasks[1].kind, 'checkpoint');
    assert.deepEqual(result.tasksMeta.tasks[1].dependencies, [1]);
    assert.equal(result.tasksMeta.tasks[1].id, 'task_2');
    assert.equal(result.tasksMeta.tasks[1].status, 'pending');
  });

  it('persists title from descriptor for audit-readable autoCompleted entries', () => {
    const ticket = freshTicket('GH-410-KIND-TITLE');
    const descriptors = [
      { num: 1, type: 'checkpoint', title: 'End-to-end verification' },
      { num: 2, type: 'backend' },
    ];
    const result = initTasksMeta(ticket, descriptors);
    assert.ok(result.success);
    assert.equal(result.tasksMeta.tasks[0].title, 'End-to-end verification');
    assert.equal(result.tasksMeta.tasks[1].title, undefined,
      'descriptor without title must NOT carry a title field');
  });
});
