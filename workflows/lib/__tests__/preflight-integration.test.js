/**
 * P1 integration + guardrail tests for preflight and supporting modules.
 *
 * IDEA2 / GH-219 — Task 18: Integration tests for parallel-ready tasks,
 * counter collisions, ambiguous origin, invalid graph.
 *
 * Requirements covered:
 *   R19 — Integration tests for mixed serial/parallel dependency graphs
 *   R20 — Guardrail tests for edge cases (ambiguous origin, out-of-flow,
 *          counter races, invalid graph, etc.)
 *   R18 — Remediation quality bar: deny-path tests assert remediation
 *          includes ruleId, evaluated state snapshot, and concrete fix steps
 *          (non-empty remediation strings array)
 *   R16 — Legacy ticket fixtures in integration where applicable
 *
 * Run: node --test workflows/lib/__tests__/preflight-integration.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated TASKS_BASE before any module requires
const TEMP_TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-integ-'));
const SAVED_TASKS_BASE = process.env.TASKS_BASE; // save for restoration in after()
process.env.TASKS_BASE = TEMP_TASKS_BASE;
const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  runPreflight,
  isWriteAllowedPath,
  createGraphCheck,
  createClaimCheck,
  createPathCheck,
} = require(path.join(__dirname, '..', 'preflight'));

const workState = require(path.join(__dirname, '..', '..', 'work', 'work-state'));
const requestIndex = require(path.join(__dirname, '..', 'request-index'));

// ─── Helpers ────────────────────────────────────────────────────────────────

function freshTicket(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

function cleanupTicket(ticketId) {
  try {
    fs.rmSync(path.join(TEMP_TASKS_BASE, ticketId), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

after(() => {
  // Restore original TASKS_BASE
  if (SAVED_TASKS_BASE) process.env.TASKS_BASE = SAVED_TASKS_BASE;
  else delete process.env.TASKS_BASE;
  try {
    fs.rmSync(TEMP_TASKS_BASE, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// R4, R19 — Invalid graph tests (unknown dep, cycle, self-dep)
// ═══════════════════════════════════════════════════════════════════════════

describe('integration — invalid graph: unknown dependency (R4, R19)', () => {
  it('preflight denies graph with unknown dep (Task 3 -> Task 99) and reports UNKNOWN_DEPENDENCY', () => {
    const ctx = {
      ticketId: 'GH-INT-1',
      origin: 'workflow',
      error: null,
      tasks: [
        { num: 1, dependencies: [] },
        { num: 2, dependencies: [] },
        { num: 3, dependencies: [99] },
      ],
      state: { status: 'in_progress' },
      hasWorkflow: true,
    };

    const result = runPreflight(ctx, { checks: [createGraphCheck()] });

    assert.equal(result.allow, false, 'unknown dep must deny');
    assert.ok(
      result.reasons.includes('UNKNOWN_DEPENDENCY'),
      `reasons must include UNKNOWN_DEPENDENCY, got: ${JSON.stringify(result.reasons)}`
    );
    assert.ok(result.remediation.length > 0, 'remediation must list fix steps');
    // Remediation must mention the missing task id
    assert.ok(
      result.remediation.some((r) => r.includes('99')),
      'remediation must reference the unknown task id (99)'
    );
  });
});

describe('integration — invalid graph: dependency cycle (R4, R19)', () => {
  it('preflight denies 2-cycle (A->B->A) with DEPENDENCY_CYCLE', () => {
    const ctx = {
      ticketId: 'GH-INT-2',
      origin: 'workflow',
      error: null,
      tasks: [
        { num: 1, dependencies: [2] },
        { num: 2, dependencies: [1] },
      ],
      state: { status: 'in_progress' },
      hasWorkflow: true,
    };

    const result = runPreflight(ctx, { checks: [createGraphCheck()] });

    assert.equal(result.allow, false, 'cycle must deny');
    assert.ok(result.reasons.includes('DEPENDENCY_CYCLE'));
    assert.ok(result.remediation.length > 0);
  });

  it('preflight denies 3-cycle (1->2->3->1) with DEPENDENCY_CYCLE', () => {
    const ctx = {
      ticketId: 'GH-INT-3',
      origin: 'workflow',
      error: null,
      tasks: [
        { num: 1, dependencies: [3] },
        { num: 2, dependencies: [1] },
        { num: 3, dependencies: [2] },
      ],
      state: { status: 'in_progress' },
      hasWorkflow: true,
    };

    const result = runPreflight(ctx, { checks: [createGraphCheck()] });

    assert.equal(result.allow, false, '3-cycle must deny');
    assert.ok(result.reasons.includes('DEPENDENCY_CYCLE'));
  });
});

describe('integration — invalid graph: self-dependency (R4, R19)', () => {
  it('preflight denies self-dep (Task 1 -> Task 1) with SELF_DEPENDENCY', () => {
    const ctx = {
      ticketId: 'GH-INT-4',
      origin: 'workflow',
      error: null,
      tasks: [
        { num: 1, dependencies: [1] },
        { num: 2, dependencies: [] },
      ],
      state: { status: 'in_progress' },
      hasWorkflow: true,
    };

    const result = runPreflight(ctx, { checks: [createGraphCheck()] });

    assert.equal(result.allow, false, 'self-dep must deny');
    assert.ok(result.reasons.includes('SELF_DEPENDENCY'));
    assert.ok(result.remediation.length > 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R19 — Mixed serial/parallel dependency graphs
// ═══════════════════════════════════════════════════════════════════════════

describe('integration — mixed serial/parallel dependency graph (R19)', () => {
  // Diamond: 1 -> 2, 1 -> 3, 2 -> 4, 3 -> 4 (tasks 2 and 3 can run in parallel)
  it('allows parallel-ready tasks (2 and 3) when their shared dependency (1) is complete', () => {
    const tasks = [
      { num: 1, dependencies: [] },
      { num: 2, dependencies: [1] },
      { num: 3, dependencies: [1] },
      { num: 4, dependencies: [2, 3] },
    ];

    const tasksMeta = {
      totalTasks: 4,
      currentTaskIndex: 1,
      tasks: [
        { id: 'task_1', status: 'completed', dependencies: [] },
        { id: 'task_2', status: 'pending', dependencies: [1] },
        { id: 'task_3', status: 'pending', dependencies: [1] },
        { id: 'task_4', status: 'pending', dependencies: [2, 3] },
      ],
    };

    const ctx = {
      ticketId: 'GH-INT-DIAMOND',
      origin: 'workflow',
      error: null,
      tasks,
      state: { status: 'in_progress', tasksMeta },
      hasWorkflow: true,
    };

    // Both task 2 and task 3 should be startable (parallel)
    const check2 = createClaimCheck({ taskNum: 2, ownerId: 'PR1' });
    const check3 = createClaimCheck({ taskNum: 3, ownerId: 'PR2' });

    const result2 = runPreflight(ctx, { checks: [createGraphCheck(), check2] });
    const result3 = runPreflight(ctx, { checks: [createGraphCheck(), check3] });

    assert.equal(result2.allow, true, 'task 2 with dep 1 complete is startable');
    assert.equal(result3.allow, true, 'task 3 with dep 1 complete is startable in parallel');
  });

  it('denies task 4 when only one of its deps (2, 3) is complete', () => {
    const tasks = [
      { num: 1, dependencies: [] },
      { num: 2, dependencies: [1] },
      { num: 3, dependencies: [1] },
      { num: 4, dependencies: [2, 3] },
    ];

    const tasksMeta = {
      totalTasks: 4,
      currentTaskIndex: 3,
      tasks: [
        { id: 'task_1', status: 'completed', dependencies: [] },
        { id: 'task_2', status: 'completed', dependencies: [1] },
        { id: 'task_3', status: 'pending', dependencies: [1] },
        { id: 'task_4', status: 'pending', dependencies: [2, 3] },
      ],
    };

    const ctx = {
      ticketId: 'GH-INT-DIAMOND-HALF',
      origin: 'workflow',
      error: null,
      tasks,
      state: { status: 'in_progress', tasksMeta },
      hasWorkflow: true,
    };

    const check4 = createClaimCheck({ taskNum: 4, ownerId: 'PR1' });
    const result = runPreflight(ctx, { checks: [createGraphCheck(), check4] });

    assert.equal(result.allow, false, 'task 4 with task 3 still pending must deny');
    assert.ok(result.reasons.includes('DEPENDENCY_NOT_READY'));
  });

  it('graph validation accepts a complex valid DAG (chain + fan-out + fan-in)', () => {
    // Tasks: 1 (root), 2 depends on 1, 3 depends on 1, 4 depends on 2,
    //         5 depends on 2+3 (fan-in), 6 depends on 4+5 (final merge)
    const tasks = [
      { num: 1, dependencies: [] },
      { num: 2, dependencies: [1] },
      { num: 3, dependencies: [1] },
      { num: 4, dependencies: [2] },
      { num: 5, dependencies: [2, 3] },
      { num: 6, dependencies: [4, 5] },
    ];

    const ctx = {
      ticketId: 'GH-INT-COMPLEX-DAG',
      origin: 'workflow',
      error: null,
      tasks,
      state: { status: 'in_progress' },
      hasWorkflow: true,
    };

    const result = runPreflight(ctx, { checks: [createGraphCheck()] });
    assert.equal(result.allow, true, 'complex valid DAG must pass graph validation');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R20 — Ambiguous --subtask (flag set, no state)
// ═══════════════════════════════════════════════════════════════════════════

describe('integration — ambiguous --subtask origin (R20, R2)', () => {
  it('context.error with AMBIGUOUS_SUBTASK denies with remediation to initialize or remove flag', () => {
    // Simulates: --subtask set but no matching subtask state file found
    const ctx = {
      ticketId: 'GH-INT-SUBTASK',
      origin: null,
      error: {
        code: 'AMBIGUOUS_SUBTASK',
        message: '--subtask flag is set but no subtask state file found',
        remediation: [
          'Initialize the subtask state before using --subtask.',
          'Remove the --subtask flag if this is a main workflow invocation.',
        ],
      },
      state: null,
      tasks: null,
      subtaskState: null,
      hasWorkflow: false,
    };

    const result = runPreflight(ctx);

    assert.equal(result.allow, false, 'ambiguous subtask must deny');
    assert.ok(result.reasons.includes('AMBIGUOUS_SUBTASK'));
    assert.ok(result.remediation.length >= 2, 'must include at least two remediation steps');
    assert.ok(
      result.remediation.some((r) => r.toLowerCase().includes('subtask')),
      'remediation must mention subtask'
    );
  });

  it('audit entry captures the ambiguous subtask denial', () => {
    const audited = [];
    const ctx = {
      ticketId: 'GH-INT-SUBTASK-AUDIT',
      origin: null,
      error: {
        code: 'AMBIGUOUS_SUBTASK',
        message: 'no subtask state found',
        remediation: ['Initialize subtask first'],
      },
    };

    runPreflight(ctx, { audit: (e) => audited.push(e) });

    assert.equal(audited.length, 1);
    assert.equal(audited[0].decision, 'deny');
    assert.ok(audited[0].reasons.includes('AMBIGUOUS_SUBTASK'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R11, R20 — Concurrent request index (parallel increments)
// ═══════════════════════════════════════════════════════════════════════════

describe('integration — concurrent request index sequential increments (R11, R20)', () => {
  let TICKET;

  beforeEach(() => {
    TICKET = freshTicket('INT-REQIDX');
    cleanupTicket(TICKET);
  });

  it('rapid sequential user request allocations yield strictly increasing sequences', () => {
    const results = [];
    for (let i = 0; i < 15; i++) {
      results.push(requestIndex.nextUserRequest(TICKET));
    }

    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i].seq > results[i - 1].seq,
        `user-request sequence not monotonic at index ${i}: ${results[i - 1].seq} >= ${results[i].seq}`
      );
    }
    assert.equal(results[results.length - 1].seq, 15);

    // Verify disk state is consistent
    const idx = requestIndex.readIndex(TICKET);
    assert.equal(idx.userSeq, 15, 'persisted userSeq must equal last allocation');
  });

  it('rapid sequential AI request allocations yield strictly increasing sequences', () => {
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(requestIndex.nextAiRequest(TICKET));
    }

    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i].seq > results[i - 1].seq,
        `ai-request sequence not monotonic at index ${i}`
      );
    }
    assert.equal(results[results.length - 1].seq, 10);
  });

  it('interleaved user and AI allocations maintain independent counters', () => {
    const u1 = requestIndex.nextUserRequest(TICKET);
    const a1 = requestIndex.nextAiRequest(TICKET);
    const u2 = requestIndex.nextUserRequest(TICKET);
    const a2 = requestIndex.nextAiRequest(TICKET);
    const u3 = requestIndex.nextUserRequest(TICKET);

    assert.equal(u1.seq, 1);
    assert.equal(a1.seq, 1, 'AI counter starts independent of user counter');
    assert.equal(u2.seq, 2);
    assert.equal(a2.seq, 2);
    assert.equal(u3.seq, 3);

    const idx = requestIndex.readIndex(TICKET);
    assert.equal(idx.userSeq, 3);
    assert.equal(idx.aiSeq, 2);
  });

  it('each allocation creates a unique directory on disk', () => {
    const r1 = requestIndex.nextUserRequest(TICKET);
    const r2 = requestIndex.nextUserRequest(TICKET);
    const r3 = requestIndex.nextAiRequest(TICKET);

    assert.notEqual(r1.root, r2.root, 'user-request-1 and user-request-2 must differ');
    assert.notEqual(r1.root, r3.root, 'user-request-1 and ai-request-1 must differ');

    assert.ok(fs.existsSync(r1.root), 'user-request-1 dir must exist');
    assert.ok(fs.existsSync(r2.root), 'user-request-2 dir must exist');
    assert.ok(fs.existsSync(r3.root), 'ai-request-1 dir must exist');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R14, R19 — Two PR workers with distinct roots
// ═══════════════════════════════════════════════════════════════════════════

describe('integration — two PR workers with distinct roots (R14, R19)', () => {
  let TICKET;

  beforeEach(() => {
    TICKET = freshTicket('INT-PR-WORKERS');
    cleanupTicket(TICKET);
  });

  it('two allocateWorkerSlot calls produce distinct PR directories', () => {
    const pr1 = workState.allocateWorkerSlot(TICKET);
    const pr2 = workState.allocateWorkerSlot(TICKET);

    assert.notEqual(pr1.slot, pr2.slot, 'slots must differ');
    assert.notEqual(pr1.ownerId, pr2.ownerId, 'owner ids must differ');
    assert.notEqual(pr1.dir, pr2.dir, 'directories must differ');

    assert.equal(pr1.ownerId, 'PR1');
    assert.equal(pr2.ownerId, 'PR2');

    // Both directories exist on disk
    assert.ok(fs.existsSync(pr1.dir), 'PR1 dir exists');
    assert.ok(fs.existsSync(pr2.dir), 'PR2 dir exists');

    // Paths do not overlap
    assert.ok(
      !pr1.dir.startsWith(pr2.dir) && !pr2.dir.startsWith(pr1.dir),
      'PR directories must not be nested within each other'
    );
  });

  it('each PR worker writes only to its own directory (path gate enforcement)', () => {
    const pr1 = workState.allocateWorkerSlot(TICKET);
    const pr2 = workState.allocateWorkerSlot(TICKET);
    const ticketRoot = path.join(TEMP_TASKS_BASE, TICKET);

    // PR1 worker paths
    const pr1Paths = {
      prDir: pr1.dir,
      taskDir: path.join(ticketRoot, 'task1'),
      ticketRoot,
    };

    // PR2 worker paths
    const pr2Paths = {
      prDir: pr2.dir,
      taskDir: path.join(ticketRoot, 'task2'),
      ticketRoot,
    };

    // PR1 can write to its own dir
    assert.ok(
      isWriteAllowedPath(path.join(pr1.dir, 'src', 'file.js'), pr1Paths),
      'PR1 allowed to write under PR1/'
    );

    // PR1 cannot write to PR2 dir
    assert.equal(
      isWriteAllowedPath(path.join(pr2.dir, 'src', 'file.js'), pr1Paths),
      false,
      'PR1 must NOT write under PR2/'
    );

    // PR2 can write to its own dir
    assert.ok(
      isWriteAllowedPath(path.join(pr2.dir, 'src', 'file.js'), pr2Paths),
      'PR2 allowed to write under PR2/'
    );

    // PR2 cannot write to PR1 dir
    assert.equal(
      isWriteAllowedPath(path.join(pr1.dir, 'src', 'file.js'), pr2Paths),
      false,
      'PR2 must NOT write under PR1/'
    );

    // Both can write shared-root whitelist
    assert.ok(
      isWriteAllowedPath(path.join(ticketRoot, '.work-state.json'), pr1Paths),
      'PR1 can write .work-state.json at ticket root'
    );
    assert.ok(
      isWriteAllowedPath(path.join(ticketRoot, '.work-state.json'), pr2Paths),
      'PR2 can write .work-state.json at ticket root'
    );
  });

  it('two workers claim different tasks and preflight allows both (full composition)', () => {
    const tasks = [
      { num: 1, dependencies: [] },
      { num: 2, dependencies: [] },
    ];
    const tasksMeta = {
      totalTasks: 2,
      currentTaskIndex: 0,
      tasks: [
        { id: 'task_1', status: 'pending', dependencies: [] },
        { id: 'task_2', status: 'pending', dependencies: [] },
      ],
    };

    const pr1 = workState.allocateWorkerSlot(TICKET);
    const pr2 = workState.allocateWorkerSlot(TICKET);
    const ticketRoot = path.join(TEMP_TASKS_BASE, TICKET);

    const ctx = {
      ticketId: TICKET,
      origin: 'workflow',
      error: null,
      tasks,
      state: { status: 'in_progress', tasksMeta },
      hasWorkflow: true,
    };

    // Worker 1 claims task 1
    const checks1 = [
      createGraphCheck(),
      createClaimCheck({ taskNum: 1, ownerId: pr1.ownerId }),
      createPathCheck({
        filePath: path.join(pr1.dir, 'src', 'main.js'),
        allowedPaths: {
          prDir: pr1.dir,
          taskDir: path.join(ticketRoot, 'task1'),
          ticketRoot,
        },
      }),
    ];

    // Worker 2 claims task 2
    const checks2 = [
      createGraphCheck(),
      createClaimCheck({ taskNum: 2, ownerId: pr2.ownerId }),
      createPathCheck({
        filePath: path.join(pr2.dir, 'src', 'other.js'),
        allowedPaths: {
          prDir: pr2.dir,
          taskDir: path.join(ticketRoot, 'task2'),
          ticketRoot,
        },
      }),
    ];

    const result1 = runPreflight(ctx, { checks: checks1 });
    const result2 = runPreflight(ctx, { checks: checks2 });

    assert.equal(result1.allow, true, 'worker 1 on task 1 allowed');
    assert.equal(result2.allow, true, 'worker 2 on task 2 allowed in parallel');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R18 — Remediation quality bar (ruleId, evaluated state, fix steps)
// ═══════════════════════════════════════════════════════════════════════════

describe('integration — R18 remediation quality bar', () => {
  it('UNKNOWN_DEPENDENCY deny includes ruleId, evaluated state reference, and non-empty remediation', () => {
    const ctx = {
      ticketId: 'GH-R18-1',
      origin: 'workflow',
      error: null,
      tasks: [
        { num: 1, dependencies: [] },
        { num: 2, dependencies: [99] },
      ],
      state: { status: 'in_progress' },
      hasWorkflow: true,
    };

    const audited = [];
    const result = runPreflight(ctx, {
      checks: [createGraphCheck()],
      audit: (e) => audited.push(e),
    });

    // 1. ruleId assertion: each reason IS the stable ruleId
    assert.equal(result.allow, false);
    assert.ok(result.reasons.length > 0, 'at least one ruleId present');
    for (const ruleId of result.reasons) {
      assert.equal(typeof ruleId, 'string', 'ruleId is a string');
      assert.ok(ruleId.length > 0, 'ruleId is non-empty');
      assert.match(ruleId, /^[A-Z][A-Z0-9_]+$/, `ruleId "${ruleId}" must be SCREAMING_SNAKE_CASE`);
    }

    // 2. Evaluated state snapshot: the audit entry captures origin and ticketId
    //    which represents the evaluated state at decision time
    assert.equal(audited.length, 1);
    assert.equal(audited[0].decision, 'deny');
    assert.equal(audited[0].ticketId, 'GH-R18-1', 'audit captures ticketId (state snapshot)');
    assert.equal(audited[0].origin, 'workflow', 'audit captures origin (state snapshot)');
    assert.ok(
      Array.isArray(audited[0].reasons) && audited[0].reasons.length > 0,
      'audit reasons populated for state snapshot'
    );

    // 3. Concrete fix steps: remediation array with actionable strings
    assert.ok(Array.isArray(result.remediation), 'remediation is an array');
    assert.ok(result.remediation.length > 0, 'remediation has at least one step');
    for (const step of result.remediation) {
      assert.equal(typeof step, 'string', 'each remediation step is a string');
      assert.ok(step.length > 0, 'remediation step is non-empty');
    }
    // Remediation must mention the offending task and the missing dependency
    const allRemediation = result.remediation.join(' ');
    assert.ok(
      allRemediation.includes('99') || allRemediation.includes('Task 99'),
      'remediation must reference the missing dependency (99)'
    );
  });

  it('DEPENDENCY_NOT_READY deny includes ruleId, state snapshot, and concrete remediation', () => {
    const ctx = {
      ticketId: 'GH-R18-2',
      origin: 'workflow',
      error: null,
      tasks: [
        { num: 1, dependencies: [] },
        { num: 2, dependencies: [1] },
      ],
      state: {
        status: 'in_progress',
        tasksMeta: {
          totalTasks: 2,
          currentTaskIndex: 0,
          tasks: [
            { id: 'task_1', status: 'pending', dependencies: [] },
            { id: 'task_2', status: 'pending', dependencies: [1] },
          ],
        },
      },
      hasWorkflow: true,
    };

    const audited = [];
    const result = runPreflight(ctx, {
      checks: [createClaimCheck({ taskNum: 2, ownerId: 'PR1' })],
      audit: (e) => audited.push(e),
    });

    // ruleId
    assert.equal(result.allow, false);
    assert.ok(result.reasons.includes('DEPENDENCY_NOT_READY'));

    // State snapshot in audit
    assert.equal(audited.length, 1);
    assert.equal(audited[0].ticketId, 'GH-R18-2');
    assert.equal(audited[0].origin, 'workflow');

    // Concrete remediation
    assert.ok(result.remediation.length >= 2, 'at least 2 remediation steps for dependency issue');
    const allRemediation = result.remediation.join(' ');
    assert.ok(
      allRemediation.includes('Task 1') || allRemediation.includes('task 1'),
      'remediation must reference the blocking dependency (Task 1)'
    );
    assert.ok(
      allRemediation.toLowerCase().includes('complete') ||
        allRemediation.toLowerCase().includes('canstart'),
      'remediation must suggest completing the dependency or checking canStart'
    );
  });

  it('UNCLAIMED_TASK_WRITE deny includes ruleId, and remediation mentions claimTask', () => {
    const ctx = {
      ticketId: 'GH-R18-3',
      origin: 'workflow',
      error: null,
      tasks: [{ num: 1, dependencies: [] }],
      state: {
        status: 'in_progress',
        tasksMeta: {
          totalTasks: 1,
          currentTaskIndex: 0,
          tasks: [{ id: 'task_1', status: 'pending', dependencies: [] }],
        },
      },
      hasWorkflow: true,
    };

    const result = runPreflight(ctx, {
      checks: [createClaimCheck({ taskNum: 1 })], // no ownerId = unclaimed
    });

    assert.equal(result.allow, false);
    assert.ok(result.reasons.includes('UNCLAIMED_TASK_WRITE'));
    assert.ok(result.remediation.length > 0);
    assert.ok(
      result.remediation.some((r) => r.toLowerCase().includes('claim')),
      'remediation must mention claiming the task'
    );
  });

  it('PATH_NOT_ALLOWED deny includes ruleId and remediation with allowed path guidance', () => {
    const ctx = {
      ticketId: 'GH-R18-4',
      origin: 'workflow',
      error: null,
      hasWorkflow: true,
    };

    const result = runPreflight(ctx, {
      checks: [
        createPathCheck({
          filePath: '/unauthorized/path/file.js',
          allowedPaths: {
            prDir: '/tasks/GH-R18-4/PR1',
            taskDir: '/tasks/GH-R18-4/task1',
            ticketRoot: '/tasks/GH-R18-4',
          },
        }),
      ],
    });

    assert.equal(result.allow, false);
    assert.ok(result.reasons.includes('PATH_NOT_ALLOWED'));
    assert.ok(result.remediation.length >= 2, 'path denial needs multiple remediation steps');
    const allRemediation = result.remediation.join(' ');
    assert.ok(
      allRemediation.includes('PR{N}') || allRemediation.includes('task${N}'),
      'remediation must describe the allowed path patterns'
    );
  });

  it('DEPENDENCY_CYCLE deny includes ruleId and remediation mentioning how to break the cycle', () => {
    const ctx = {
      ticketId: 'GH-R18-5',
      origin: 'workflow',
      error: null,
      tasks: [
        { num: 1, dependencies: [2] },
        { num: 2, dependencies: [1] },
      ],
      state: { status: 'in_progress' },
      hasWorkflow: true,
    };

    const audited = [];
    const result = runPreflight(ctx, {
      checks: [createGraphCheck()],
      audit: (e) => audited.push(e),
    });

    assert.equal(result.allow, false);
    assert.ok(result.reasons.includes('DEPENDENCY_CYCLE'));

    // Audit captures state snapshot
    assert.equal(audited.length, 1);
    assert.equal(audited[0].ticketId, 'GH-R18-5');

    // Remediation is actionable
    assert.ok(result.remediation.length > 0);
    const allRemediation = result.remediation.join(' ');
    assert.ok(
      allRemediation.toLowerCase().includes('cycle') ||
        allRemediation.toLowerCase().includes('break'),
      'cycle remediation must suggest breaking the cycle'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R16 — Legacy ticket fixture (pre-IDEA2 backward compat)
// ═══════════════════════════════════════════════════════════════════════════

describe('integration — legacy ticket fixture without dependencies field (R16)', () => {
  it('preflight allows legacy tasksMeta (no dependencies field) with claim check', () => {
    const ctx = {
      ticketId: 'LEGACY-INT-1',
      origin: 'workflow',
      error: null,
      tasks: null,
      state: {
        status: 'in_progress',
        tasksMeta: {
          totalTasks: 3,
          currentTaskIndex: 0,
          tasks: [
            { id: 'task_1', status: 'pending' }, // no dependencies field
            { id: 'task_2', status: 'pending' },
            { id: 'task_3', status: 'pending' },
          ],
        },
      },
      hasWorkflow: true,
    };

    // Legacy mode: claim check with taskNum=1 and ownerId should pass
    // because there are no dependencies to block
    const check = createClaimCheck({ taskNum: 1, ownerId: 'PR1' });
    const result = runPreflight(ctx, { checks: [check] });

    assert.equal(result.allow, true, 'legacy task without dependencies field must allow (R16)');
  });

  it('graph check passes when tasks is null (no graph to validate — legacy mode)', () => {
    const ctx = {
      ticketId: 'LEGACY-INT-2',
      origin: 'workflow',
      error: null,
      tasks: null,
      state: { status: 'in_progress' },
      hasWorkflow: true,
    };

    const result = runPreflight(ctx, { checks: [createGraphCheck()] });
    assert.equal(result.allow, true, 'null tasks means no graph to validate — legacy allow');
  });

  it('claim check passes when state has no tasksMeta (legacy mode, R16)', () => {
    const ctx = {
      ticketId: 'LEGACY-INT-3',
      origin: 'workflow',
      error: null,
      tasks: null,
      state: { status: 'in_progress' },
      hasWorkflow: true,
    };

    const check = createClaimCheck({ taskNum: 1, ownerId: 'PR1' });
    const result = runPreflight(ctx, { checks: [check] });
    assert.equal(result.allow, true, 'no tasksMeta = legacy mode, allow (R16)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R20 — Composed error: multiple failures aggregate
// ═══════════════════════════════════════════════════════════════════════════

describe('integration — composed multi-failure aggregation (R20)', () => {
  it('context error + graph error + unclaimed write = all reasons aggregated', () => {
    const ctx = {
      ticketId: 'GH-INT-MULTI',
      origin: null,
      error: {
        code: 'AMBIGUOUS_SUBTASK',
        message: 'subtask flag without state',
        remediation: ['Remove --subtask flag'],
      },
      tasks: [
        { num: 1, dependencies: [1] }, // self-dep
      ],
      state: {
        status: 'in_progress',
        tasksMeta: {
          totalTasks: 1,
          currentTaskIndex: 0,
          tasks: [{ id: 'task_1', status: 'pending', dependencies: [1] }],
        },
      },
      hasWorkflow: true,
    };

    const checks = [
      createGraphCheck(),
      createClaimCheck({ taskNum: 1 }), // no ownerId
    ];

    const result = runPreflight(ctx, { checks });

    assert.equal(result.allow, false);
    // Should have at least 3 distinct reasons: AMBIGUOUS_SUBTASK + SELF_DEPENDENCY + UNCLAIMED_TASK_WRITE
    assert.ok(
      result.reasons.length >= 3,
      `expected >= 3 reasons, got ${result.reasons.length}: ${JSON.stringify(result.reasons)}`
    );
    assert.ok(result.reasons.includes('AMBIGUOUS_SUBTASK'));
    assert.ok(result.reasons.includes('SELF_DEPENDENCY'));
    assert.ok(result.reasons.includes('UNCLAIMED_TASK_WRITE'));

    // All remediation steps aggregated
    assert.ok(result.remediation.length >= 3, 'aggregated remediation from all deny sources');
  });
});
