/**
 * Tests for dependency graph support in work-state.js
 *
 * IDEA2 / GH-219 — Task 5: `tasksMeta` dependencies + graph validation +
 * `canStart(ticketId, taskNum)` readiness query.
 *
 * Requirements covered:
 *   R3  — Dependency readiness: `canStart(taskNum)` iff all declared
 *         dependencies complete; tasks with no dependencies are startable.
 *   R4  — Graph validation before writes: unknown dep id, self-dependency,
 *         cycles; fail closed with structured remediation; invalid graphs
 *         never reach disk.
 *   R16 — Backward compatibility: pre-IDEA2 `.work-state.json` files whose
 *         `tasksMeta.tasks[*]` lack a `dependencies` field must still load;
 *         `canStart` defaults to true for those tasks (matches pre-IDEA2
 *         sequential "always startable" behavior — orchestrator drives
 *         order via `currentTaskIndex`).
 *
 * Uses node:test + node:assert/strict with direct `require()` of work-state
 * (pure-function testing for graph validator + readiness query is far cleaner
 * than CLI spawns for array-shaped inputs). The existing work-state.test.js
 * and task-tracking.test.js cover CLI backward compatibility.
 *
 * Run: node --test workflows/work/__tests__/work-state-graph.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Set TASKS_BASE BEFORE requiring work-state so config.js picks up the
// isolated temp directory at module-load time (see workflows/lib/config.js
// lines 125–127 — TASKS_BASE is resolved once at require() time).
const TEMP_TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'work-state-graph-test-'));
const ORIGINAL_TASKS_BASE = process.env.TASKS_BASE;
process.env.TASKS_BASE = TEMP_TASKS_BASE;

// Clear cached modules that read TASKS_BASE at require time so our
// TEMP_TASKS_BASE override takes effect even if another test loaded them first.
delete require.cache[require.resolve('../../lib/config')];
delete require.cache[require.resolve('../work-state')];
delete require.cache[require.resolve('../work-state/graph-validation')];
delete require.cache[require.resolve('../work-state/task-readiness')];
delete require.cache[require.resolve('../work-state/parallel-workers')];

const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const workState = require(path.join(__dirname, '..', 'work-state'));

// ─── Helpers ────────────────────────────────────────────────────────────────

function freshTicket(prefix) {
  // Append random suffix to guarantee isolation between tests in the same
  // process — direct-require tests share the same TASKS_BASE.
  return `${prefix}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

function cleanupTicket(ticketId) {
  try {
    fs.rmSync(path.join(TEMP_TASKS_BASE, ticketId), { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

after(() => {
  // Restore original TASKS_BASE so subsequent test files in the same process
  // do not inherit the (now-deleted) temp directory.
  if (ORIGINAL_TASKS_BASE === undefined) {
    delete process.env.TASKS_BASE;
  } else {
    process.env.TASKS_BASE = ORIGINAL_TASKS_BASE;
  }
  // Clear require.cache so other test files get fresh config
  delete require.cache[require.resolve('../../lib/config')];
  delete require.cache[require.resolve('../work-state')];
  delete require.cache[require.resolve('../work-state/graph-validation')];
  delete require.cache[require.resolve('../work-state/task-readiness')];
  delete require.cache[require.resolve('../work-state/parallel-workers')];
  try {
    fs.rmSync(TEMP_TASKS_BASE, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ───────────────────────────────────────────────────────────────────────────
// validateTaskGraph — pure graph validator (R4)
// ───────────────────────────────────────────────────────────────────────────

describe('validateTaskGraph (R4 — pure graph validator)', () => {
  it('is exported as a function from work-state', () => {
    assert.equal(
      typeof workState.validateTaskGraph,
      'function',
      'validateTaskGraph must be exported so Task 12 preflight can reuse it'
    );
  });

  it('returns { valid: true, errors: [] } for empty tasks array', () => {
    const result = workState.validateTaskGraph([]);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('returns { valid: true, errors: [] } when no tasks declare dependencies', () => {
    const result = workState.validateTaskGraph([
      { num: 1, dependencies: [] },
      { num: 2, dependencies: [] },
      { num: 3, dependencies: [] },
    ]);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('returns { valid: true } for a valid DAG (1 ← 2 ← 3, plus 3 ← 1)', () => {
    const result = workState.validateTaskGraph([
      { num: 1, dependencies: [] },
      { num: 2, dependencies: [1] },
      { num: 3, dependencies: [1, 2] },
    ]);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('treats missing `dependencies` field as empty (no error)', () => {
    const result = workState.validateTaskGraph([{ num: 1 }, { num: 2 }]);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('detects self-dependency (A→A) with structured remediation', () => {
    const result = workState.validateTaskGraph([{ num: 1, dependencies: [1] }]);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 1);
    const err = result.errors.find((e) => e.code === 'SELF_DEPENDENCY');
    assert.ok(err, 'errors must include a SELF_DEPENDENCY entry');
    assert.equal(err.taskId, 'task_1');
    assert.ok(typeof err.message === 'string' && err.message.includes('1'));
    assert.ok(Array.isArray(err.remediation));
    assert.ok(err.remediation.length > 0, 'remediation must be non-empty for R18 explainability');
  });

  it('detects unknown dependency id (Task 2 → Task 99)', () => {
    const result = workState.validateTaskGraph([
      { num: 1, dependencies: [] },
      { num: 2, dependencies: [99] },
    ]);
    assert.equal(result.valid, false);
    const err = result.errors.find((e) => e.code === 'UNKNOWN_DEPENDENCY');
    assert.ok(err, 'errors must include an UNKNOWN_DEPENDENCY entry');
    assert.equal(err.taskId, 'task_2');
    assert.ok(err.message.includes('99'));
    assert.ok(Array.isArray(err.remediation) && err.remediation.length > 0);
  });

  it('detects a 2-cycle (A→B→A) with DEPENDENCY_CYCLE error', () => {
    const result = workState.validateTaskGraph([
      { num: 1, dependencies: [2] },
      { num: 2, dependencies: [1] },
    ]);
    assert.equal(result.valid, false);
    const err = result.errors.find((e) => e.code === 'DEPENDENCY_CYCLE');
    assert.ok(err, 'errors must include DEPENDENCY_CYCLE');
    assert.ok(Array.isArray(err.remediation) && err.remediation.length > 0);
  });

  it('detects a 3-cycle (A→B→C→A) with DEPENDENCY_CYCLE error', () => {
    // A=1 depends on 3; 3 depends on 2; 2 depends on 1 → cycle 1→3→2→1
    const result = workState.validateTaskGraph([
      { num: 1, dependencies: [3] },
      { num: 2, dependencies: [1] },
      { num: 3, dependencies: [2] },
    ]);
    assert.equal(result.valid, false);
    const err = result.errors.find((e) => e.code === 'DEPENDENCY_CYCLE');
    assert.ok(err, 'errors must include DEPENDENCY_CYCLE for 3-cycle');
  });

  it('every error matches { code, taskId, message, remediation } contract', () => {
    // Invalid graph with multiple kinds of errors
    const result = workState.validateTaskGraph([
      { num: 1, dependencies: [1] }, // self-dep
      { num: 2, dependencies: [99] }, // unknown
      { num: 3, dependencies: [4] },
      { num: 4, dependencies: [3] }, // 2-cycle between 3 and 4
    ]);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 3, 'should report all error classes');
    for (const err of result.errors) {
      assert.equal(typeof err.code, 'string', 'code must be a string');
      assert.ok(err.code.length > 0, 'code must be non-empty');
      assert.ok(
        typeof err.taskId === 'string' || err.taskId === null,
        'taskId must be a string or null'
      );
      assert.equal(typeof err.message, 'string', 'message must be a string');
      assert.ok(err.message.length > 0, 'message must be non-empty');
      assert.ok(Array.isArray(err.remediation), 'remediation must be an array');
    }
  });

  it('returns validation error when input is not an array (fail-closed)', () => {
    const result = workState.validateTaskGraph(null);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 1);
    assert.equal(typeof result.errors[0].code, 'string');
  });

  it('detects duplicate task numbers with DUPLICATE_TASK_NUM error', () => {
    const result = workState.validateTaskGraph([
      { num: 1, dependencies: [] },
      { num: 1, dependencies: [] },
      { num: 2, dependencies: [] },
    ]);
    assert.equal(result.valid, false);
    const err = result.errors.find((e) => e.code === 'DUPLICATE_TASK_NUM');
    assert.ok(err, 'errors must include a DUPLICATE_TASK_NUM entry');
    assert.equal(err.taskId, 'task_1');
    assert.ok(err.message.includes('1'));
    assert.ok(Array.isArray(err.remediation) && err.remediation.length > 0);
  });

  it('detects multiple duplicate task numbers', () => {
    const result = workState.validateTaskGraph([
      { num: 1, dependencies: [] },
      { num: 1, dependencies: [] },
      { num: 2, dependencies: [] },
      { num: 2, dependencies: [] },
    ]);
    assert.equal(result.valid, false);
    const dupErrors = result.errors.filter((e) => e.code === 'DUPLICATE_TASK_NUM');
    assert.equal(dupErrors.length, 2, 'should report one DUPLICATE_TASK_NUM per duplicate occurrence');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// initTasksMeta — extended to consume parseTasks output and validate (R4)
// ───────────────────────────────────────────────────────────────────────────

describe('initTasksMeta — parseTasks output + graph validation (R3, R4, R16)', () => {
  let TICKET;
  beforeEach(() => {
    TICKET = freshTicket('TEST-GRAPH-INIT');
    cleanupTicket(TICKET);
  });

  it('persists dependencies on each task for a valid DAG (R3)', () => {
    workState.initState(TICKET);
    const result = workState.initTasksMeta(TICKET, [
      { num: 1, dependencies: [] },
      { num: 2, dependencies: [1] },
      { num: 3, dependencies: [1, 2] },
    ]);
    assert.ok(!result.error, `should succeed for valid DAG, got: ${JSON.stringify(result)}`);

    const state = workState.loadState(TICKET);
    assert.equal(state.tasksMeta.totalTasks, 3);
    assert.equal(state.tasksMeta.tasks.length, 3);
    assert.deepEqual(state.tasksMeta.tasks[0].dependencies, []);
    assert.deepEqual(state.tasksMeta.tasks[1].dependencies, [1]);
    assert.deepEqual(state.tasksMeta.tasks[2].dependencies, [1, 2]);
    assert.equal(state.tasksMeta.tasks[0].id, 'task_1');
    assert.equal(state.tasksMeta.tasks[0].status, 'pending');
  });

  it('rejects cycle (A→B→A) BEFORE writing tasksMeta to disk (R4)', () => {
    workState.initState(TICKET);
    const result = workState.initTasksMeta(TICKET, [
      { num: 1, dependencies: [2] },
      { num: 2, dependencies: [1] },
    ]);
    assert.ok(result.error, 'must return error descriptor');
    assert.ok(
      Array.isArray(result.errors) && result.errors.length > 0,
      'error response must include structured errors array'
    );
    const cycleErr = result.errors.find((e) => e.code === 'DEPENDENCY_CYCLE');
    assert.ok(cycleErr, 'errors must include DEPENDENCY_CYCLE');

    // Fail-closed: verify NOT persisted
    const state = workState.loadState(TICKET);
    assert.equal(
      state.tasksMeta,
      undefined,
      'invalid graph must not reach disk — tasksMeta must remain unset'
    );
  });

  it('rejects 3-cycle (A→B→C→A) BEFORE writing (R4)', () => {
    workState.initState(TICKET);
    const result = workState.initTasksMeta(TICKET, [
      { num: 1, dependencies: [3] },
      { num: 2, dependencies: [1] },
      { num: 3, dependencies: [2] },
    ]);
    assert.ok(result.error);
    assert.ok(result.errors.some((e) => e.code === 'DEPENDENCY_CYCLE'));

    const state = workState.loadState(TICKET);
    assert.equal(state.tasksMeta, undefined, '3-cycle invalid graph must not reach disk');
  });

  it('rejects self-dependency (A→A) BEFORE writing (R4)', () => {
    workState.initState(TICKET);
    const result = workState.initTasksMeta(TICKET, [{ num: 1, dependencies: [1] }]);
    assert.ok(result.error);
    assert.ok(result.errors.some((e) => e.code === 'SELF_DEPENDENCY'));

    const state = workState.loadState(TICKET);
    assert.equal(state.tasksMeta, undefined, 'self-dep invalid graph must not reach disk');
  });

  it('rejects unknown dependency id BEFORE writing (R4)', () => {
    workState.initState(TICKET);
    const result = workState.initTasksMeta(TICKET, [
      { num: 1, dependencies: [] },
      { num: 2, dependencies: [99] },
    ]);
    assert.ok(result.error);
    assert.ok(result.errors.some((e) => e.code === 'UNKNOWN_DEPENDENCY'));

    const state = workState.loadState(TICKET);
    assert.equal(state.tasksMeta, undefined, 'unknown dep invalid graph must not reach disk');
  });

  it('R16: integer taskCount form still works (no dependencies field persisted)', () => {
    workState.initState(TICKET);
    const result = workState.initTasksMeta(TICKET, 3);
    assert.ok(!result.error, 'integer form must still succeed');

    const state = workState.loadState(TICKET);
    assert.equal(state.tasksMeta.totalTasks, 3);
    assert.equal(state.tasksMeta.tasks.length, 3);
    // Pre-IDEA2 semantics: no dependencies field present in the task entries
    assert.equal(
      state.tasksMeta.tasks[0].dependencies,
      undefined,
      'integer form must not inject a dependencies field (pre-IDEA2 wire format)'
    );
  });

  it('rejects duplicate task numbers BEFORE writing to disk', () => {
    workState.initState(TICKET);
    const result = workState.initTasksMeta(TICKET, [
      { num: 1, dependencies: [] },
      { num: 1, dependencies: [] },
    ]);
    assert.ok(result.error, 'must return error for duplicate task numbers');
    assert.ok(result.error.includes('Duplicate'), `error message must mention duplicates: ${result.error}`);

    const state = workState.loadState(TICKET);
    assert.equal(state.tasksMeta, undefined, 'duplicate nums must not reach disk');
  });

  it('rejects non-contiguous task numbers (gap) BEFORE writing to disk', () => {
    workState.initState(TICKET);
    const result = workState.initTasksMeta(TICKET, [
      { num: 1, dependencies: [] },
      { num: 3, dependencies: [] },
    ]);
    assert.ok(result.error, 'must return error for non-contiguous task numbers');
    assert.ok(
      result.error.includes('contiguous'),
      `error message must mention contiguous: ${result.error}`
    );

    const state = workState.loadState(TICKET);
    assert.equal(state.tasksMeta, undefined, 'non-contiguous nums must not reach disk');
  });

  it('rejects task numbers starting at 0 (must be 1-indexed)', () => {
    workState.initState(TICKET);
    const result = workState.initTasksMeta(TICKET, [
      { num: 0, dependencies: [] },
      { num: 1, dependencies: [] },
    ]);
    assert.ok(result.error, 'must return error for task number 0');
  });

  it('R16: loads pre-IDEA2 state file lacking `dependencies` without error', () => {
    // Simulate a pre-IDEA2 state file written on disk BEFORE the schema extension.
    const taskDir = path.join(TEMP_TASKS_BASE, TICKET);
    fs.mkdirSync(taskDir, { recursive: true });
    const legacyState = {
      ticketId: TICKET,
      status: 'in_progress',
      stepStatus: {},
      checkProgress: {},
      errors: [],
      startTime: new Date().toISOString(),
      lastUpdate: new Date().toISOString(),
      tasksMeta: {
        totalTasks: 2,
        currentTaskIndex: 0,
        tasks: [
          { id: 'task_1', status: 'pending' }, // NO dependencies field
          { id: 'task_2', status: 'pending' }, // NO dependencies field
        ],
      },
    };
    fs.writeFileSync(
      path.join(taskDir, '.work-state.json'),
      JSON.stringify(legacyState, null, 2)
    );

    // loadState must not throw on the missing fields (R16)
    const loaded = workState.loadState(TICKET);
    assert.ok(loaded, 'loadState must return the legacy state unchanged');
    assert.equal(loaded.tasksMeta.tasks.length, 2);
    assert.equal(loaded.tasksMeta.tasks[0].dependencies, undefined);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// canStart(ticketId, taskNum) — pure readiness query (R3, R16)
// ───────────────────────────────────────────────────────────────────────────

describe('canStart(ticketId, taskNum) — pure dependency readiness (R3, R16)', () => {
  let TICKET;
  beforeEach(() => {
    TICKET = freshTicket('TEST-CANSTART');
    cleanupTicket(TICKET);
  });

  it('is exported from work-state (single source of truth for preflight/Task 12)', () => {
    assert.equal(
      typeof workState.canStart,
      'function',
      'canStart must be the only implementation — preflight imports from work-state'
    );
  });

  it('returns true when task has no dependencies (empty deps = startable)', () => {
    workState.initState(TICKET);
    workState.initTasksMeta(TICKET, [
      { num: 1, dependencies: [] },
      { num: 2, dependencies: [] },
    ]);
    assert.equal(workState.canStart(TICKET, 1), true);
    assert.equal(workState.canStart(TICKET, 2), true);
  });

  it('returns true when all declared dependencies are completed', () => {
    workState.initState(TICKET);
    workState.initTasksMeta(TICKET, [
      { num: 1, dependencies: [] },
      { num: 2, dependencies: [1] },
    ]);
    // Complete task 1 (simulate prior completion)
    const state = workState.loadState(TICKET);
    state.tasksMeta.tasks[0].status = 'completed';
    workState.saveState(TICKET, state);

    assert.equal(workState.canStart(TICKET, 2), true);
  });

  it('returns false when a declared dependency is still pending (R3)', () => {
    workState.initState(TICKET);
    workState.initTasksMeta(TICKET, [
      { num: 1, dependencies: [] },
      { num: 2, dependencies: [1] },
    ]);
    // Task 1 is pending — canStart(2) must be false
    assert.equal(workState.canStart(TICKET, 2), false);
  });

  it('returns false when dependencies are mixed (some completed, some pending)', () => {
    workState.initState(TICKET);
    workState.initTasksMeta(TICKET, [
      { num: 1, dependencies: [] },
      { num: 2, dependencies: [] },
      { num: 3, dependencies: [1, 2] },
    ]);
    // Only complete task 1 — task 2 is still pending
    const state = workState.loadState(TICKET);
    state.tasksMeta.tasks[0].status = 'completed';
    workState.saveState(TICKET, state);

    assert.equal(workState.canStart(TICKET, 3), false);
  });

  it('returns false for unknown dep in persisted meta (fail-closed)', () => {
    // Simulate state where a dep points to a task that does not exist in tasksMeta.
    // Can happen if a pre-IDEA2 ticket is manually edited or a corrupt state.
    const taskDir = path.join(TEMP_TASKS_BASE, TICKET);
    fs.mkdirSync(taskDir, { recursive: true });
    const state = {
      ticketId: TICKET,
      status: 'in_progress',
      stepStatus: {},
      checkProgress: {},
      errors: [],
      startTime: new Date().toISOString(),
      lastUpdate: new Date().toISOString(),
      tasksMeta: {
        totalTasks: 1,
        currentTaskIndex: 0,
        tasks: [{ id: 'task_1', status: 'pending', dependencies: [42] }],
      },
    };
    fs.writeFileSync(
      path.join(taskDir, '.work-state.json'),
      JSON.stringify(state, null, 2)
    );

    assert.equal(
      workState.canStart(TICKET, 1),
      false,
      'unknown dep reference in persisted meta must fail-closed'
    );
  });

  it('R16: returns true for pre-IDEA2 tasks without a `dependencies` field', () => {
    // Simulate a pre-IDEA2 state: tasks have NO dependencies field.
    const taskDir = path.join(TEMP_TASKS_BASE, TICKET);
    fs.mkdirSync(taskDir, { recursive: true });
    const state = {
      ticketId: TICKET,
      status: 'in_progress',
      stepStatus: {},
      checkProgress: {},
      errors: [],
      startTime: new Date().toISOString(),
      lastUpdate: new Date().toISOString(),
      tasksMeta: {
        totalTasks: 3,
        currentTaskIndex: 0,
        tasks: [
          { id: 'task_1', status: 'pending' },
          { id: 'task_2', status: 'pending' },
          { id: 'task_3', status: 'pending' },
        ],
      },
    };
    fs.writeFileSync(
      path.join(taskDir, '.work-state.json'),
      JSON.stringify(state, null, 2)
    );

    // Documented R16 default: missing dependencies field ⇒ treat as empty deps
    // ⇒ canStart returns true for any task (sequential orchestrator-driven
    // behavior is preserved — order is still enforced by currentTaskIndex).
    assert.equal(workState.canStart(TICKET, 1), true);
    assert.equal(workState.canStart(TICKET, 2), true);
    assert.equal(workState.canStart(TICKET, 3), true);
  });

  it('returns false for a non-existent task number', () => {
    workState.initState(TICKET);
    workState.initTasksMeta(TICKET, 2);
    assert.equal(workState.canStart(TICKET, 99), false);
  });

  it('returns false when no tasksMeta is initialized (fail-closed)', () => {
    workState.initState(TICKET);
    assert.equal(workState.canStart(TICKET, 1), false);
  });

  it('returns false when the task itself is already completed (nothing to start)', () => {
    workState.initState(TICKET);
    workState.initTasksMeta(TICKET, [{ num: 1, dependencies: [] }]);
    const state = workState.loadState(TICKET);
    state.tasksMeta.tasks[0].status = 'completed';
    workState.saveState(TICKET, state);

    assert.equal(
      workState.canStart(TICKET, 1),
      false,
      'a completed task cannot be "started" again — fail-closed'
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// canStartFromState — pure helper that avoids disk I/O (Fix 5)
// ───────────────────────────────────────────────────────────────────────────

describe('canStartFromState(state, taskNum) — pure readiness from loaded state', () => {
  it('is exported from work-state', () => {
    assert.equal(
      typeof workState.canStartFromState,
      'function',
      'canStartFromState must be exported for callers that already hold state'
    );
  });

  it('returns true when task has no dependencies', () => {
    const state = {
      tasksMeta: {
        tasks: [
          { id: 'task_1', status: 'pending', dependencies: [] },
        ],
      },
    };
    assert.equal(workState.canStartFromState(state, 1), true);
  });

  it('returns false when a dependency is pending', () => {
    const state = {
      tasksMeta: {
        tasks: [
          { id: 'task_1', status: 'pending', dependencies: [] },
          { id: 'task_2', status: 'pending', dependencies: [1] },
        ],
      },
    };
    assert.equal(workState.canStartFromState(state, 2), false);
  });

  it('returns true when all dependencies are completed', () => {
    const state = {
      tasksMeta: {
        tasks: [
          { id: 'task_1', status: 'completed', dependencies: [] },
          { id: 'task_2', status: 'pending', dependencies: [1] },
        ],
      },
    };
    assert.equal(workState.canStartFromState(state, 2), true);
  });

  it('returns false for null state', () => {
    assert.equal(workState.canStartFromState(null, 1), false);
  });

  it('returns false for completed task', () => {
    const state = {
      tasksMeta: {
        tasks: [
          { id: 'task_1', status: 'completed', dependencies: [] },
        ],
      },
    };
    assert.equal(workState.canStartFromState(state, 1), false);
  });

  it('returns true for pre-IDEA2 tasks without dependencies field (R16)', () => {
    const state = {
      tasksMeta: {
        tasks: [
          { id: 'task_1', status: 'pending' },
        ],
      },
    };
    assert.equal(workState.canStartFromState(state, 1), true);
  });

  it('produces same results as canStart for the same state', () => {
    const TICKET = freshTicket('TEST-CANSTART-FROM-STATE');
    cleanupTicket(TICKET);
    workState.initState(TICKET);
    workState.initTasksMeta(TICKET, [
      { num: 1, dependencies: [] },
      { num: 2, dependencies: [1] },
    ]);
    const state = workState.loadState(TICKET);

    assert.equal(workState.canStart(TICKET, 1), workState.canStartFromState(state, 1));
    assert.equal(workState.canStart(TICKET, 2), workState.canStartFromState(state, 2));
    cleanupTicket(TICKET);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// initTasksMeta idempotency — cached result returned before validation
// ───────────────────────────────────────────────────────────────────────────

describe('initTasksMeta idempotency (pre-validation short-circuit)', () => {
  it('returns cached tasksMeta even when second call passes invalid input', () => {
    const TICKET = freshTicket('TEST-IDEMP');
    cleanupTicket(TICKET);
    workState.initState(TICKET);

    // First call — valid input, should succeed
    const first = workState.initTasksMeta(TICKET, [
      { num: 1, dependencies: [] },
      { num: 2, dependencies: [1] },
    ]);
    assert.ok(!first.error, 'first initTasksMeta should succeed');
    assert.ok(first.tasksMeta || first.success, 'first call should return tasksMeta');

    // Second call — invalid input (negative count). Because idempotency
    // check runs BEFORE validation, this must return the cached result
    // rather than an error.
    const second = workState.initTasksMeta(TICKET, -1);
    assert.ok(!second.error, 'idempotent call must NOT validate inputs again');
    assert.equal(second.idempotent, true, 'must be flagged as idempotent');
    assert.ok(second.tasksMeta, 'must return cached tasksMeta');
    assert.equal(second.tasksMeta.tasks.length, 2, 'cached tasks must match original');

    cleanupTicket(TICKET);
  });
});
