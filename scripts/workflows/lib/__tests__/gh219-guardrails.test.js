/**
 * GH-219 Task 18 — Consolidated guardrail integration tests.
 *
 * Five test categories covering edge cases that exercise the full
 * preflight + enforcement-context + request-index + parallel-workers
 * stack end-to-end.
 *
 * Categories:
 *   1. Invalid Graph — cyclic and unknown dependency through preflight
 *   2. Ambiguous --subtask origin via loadEnforcementContext
 *   3. Concurrent request index (20 rapid sequential allocations)
 *   4. Two PR workers with distinct roots + path gate enforcement
 *   5. R18 remediation quality bar (deny without claim)
 *
 * Run: node --test workflows/lib/__tests__/gh219-guardrails.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── Isolated TASKS_BASE before any module requires ──────────────────────────

const TEMP_TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'gh219-guardrails-'));
const SAVED_TASKS_BASE = process.env.TASKS_BASE;
process.env.TASKS_BASE = TEMP_TASKS_BASE;

// Clear cached modules so config picks up our override
delete require.cache[require.resolve('../../lib/config')];
delete require.cache[require.resolve('../../work/work-state')];
try {
  delete require.cache[require.resolve('../../work/work-state/graph-validation')];
} catch {
  /* may not exist */
}
try {
  delete require.cache[require.resolve('../../work/work-state/task-readiness')];
} catch {
  /* may not exist */
}
try {
  delete require.cache[require.resolve('../../work/work-state/parallel-workers')];
} catch {
  /* may not exist */
}

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

// ─── Resolve enforcement context module paths for mock injection ─────────────

const ENFORCEMENT_CTX_PATH = path.join(__dirname, '..', '..', 'work', 'work-enforcement-context');
const WORK_STATE_PATH = require.resolve(path.join(__dirname, '..', '..', 'work', 'work-state'));
const TASK_PARSER_PATH = require.resolve(path.join(__dirname, '..', '..', 'work', 'task-parser'));
const CONFIG_PATH = require.resolve(path.join(__dirname, '..', '..', 'lib', 'config'));

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

/**
 * Install require.cache mocks for the enforcement context adapter.
 */
function installCtxMocks({ state = null, tasks = null, subtaskState = null, safeId } = {}) {
  require.cache[WORK_STATE_PATH] = {
    id: WORK_STATE_PATH,
    filename: WORK_STATE_PATH,
    loaded: true,
    exports: {
      loadState: (tid) => (typeof state === 'function' ? state(tid) : state),
      loadActiveSubtaskState: (tid) =>
        typeof subtaskState === 'function' ? subtaskState(tid) : subtaskState,
      allocateWorkerSlot: workState.allocateWorkerSlot,
      releaseWorkerSlot: workState.releaseWorkerSlot,
    },
  };

  require.cache[TASK_PARSER_PATH] = {
    id: TASK_PARSER_PATH,
    filename: TASK_PARSER_PATH,
    loaded: true,
    exports: {
      parseTasks: (dir) => (typeof tasks === 'function' ? tasks(dir) : tasks),
    },
  };

  require.cache[CONFIG_PATH] = {
    id: CONFIG_PATH,
    filename: CONFIG_PATH,
    loaded: true,
    exports: {
      TASKS_BASE: '/fake/tasks',
      safeTicketId: (id) => (typeof safeId === 'function' ? safeId(id) : id),
      tasksDir: (id) => path.join('/fake/tasks', id),
    },
  };

  delete require.cache[require.resolve(ENFORCEMENT_CTX_PATH)];
}

function uninstallCtxMocks() {
  delete require.cache[WORK_STATE_PATH];
  delete require.cache[TASK_PARSER_PATH];
  delete require.cache[CONFIG_PATH];
  delete require.cache[require.resolve(ENFORCEMENT_CTX_PATH)];
}

// ─── Global teardown ────────────────────────────────────────────────────────

after(() => {
  if (SAVED_TASKS_BASE) process.env.TASKS_BASE = SAVED_TASKS_BASE;
  else delete process.env.TASKS_BASE;
  try {
    fs.rmSync(TEMP_TASKS_BASE, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Invalid Graph — Integration Through Preflight
// ═══════════════════════════════════════════════════════════════════════════════

describe('guardrail 1 — invalid graph through preflight', () => {
  it('denies a 3-node cycle (A->B->C->A) with DEPENDENCY_CYCLE and invokes audit', () => {
    const audited = [];
    const ctx = {
      ticketId: 'GH-GUARD-CYCLE',
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

    const result = runPreflight(ctx, {
      checks: [createGraphCheck()],
      audit: (e) => audited.push(e),
    });

    assert.equal(result.allow, false, 'cyclic graph must deny');
    assert.ok(
      result.reasons.includes('DEPENDENCY_CYCLE'),
      `reasons must include DEPENDENCY_CYCLE, got: ${JSON.stringify(result.reasons)}`
    );
    assert.ok(result.remediation.length > 0, 'remediation must list fix steps');

    // Audit callback must be invoked with denial
    assert.equal(audited.length, 1, 'audit callback must be invoked exactly once');
    assert.equal(audited[0].decision, 'deny', 'audit entry must record deny decision');
    assert.ok(
      audited[0].reasons.includes('DEPENDENCY_CYCLE'),
      'audit entry must include DEPENDENCY_CYCLE reason'
    );
  });

  it('denies an unknown dependency (Task 1 depends on Task 99) with UNKNOWN_DEPENDENCY and invokes audit', () => {
    const audited = [];
    const ctx = {
      ticketId: 'GH-GUARD-UNKNDEP',
      origin: 'workflow',
      error: null,
      tasks: [
        { num: 1, dependencies: [99] },
        { num: 2, dependencies: [] },
      ],
      state: { status: 'in_progress' },
      hasWorkflow: true,
    };

    const result = runPreflight(ctx, {
      checks: [createGraphCheck()],
      audit: (e) => audited.push(e),
    });

    assert.equal(result.allow, false, 'unknown dependency must deny');
    assert.ok(
      result.reasons.includes('UNKNOWN_DEPENDENCY'),
      `reasons must include UNKNOWN_DEPENDENCY, got: ${JSON.stringify(result.reasons)}`
    );
    assert.ok(result.remediation.length > 0, 'remediation must list fix steps');
    assert.ok(
      result.remediation.some((r) => r.includes('99')),
      'remediation must reference the unknown task id (99)'
    );

    // Audit callback must be invoked with denial
    assert.equal(audited.length, 1, 'audit callback invoked once');
    assert.equal(audited[0].decision, 'deny');
    assert.ok(audited[0].reasons.includes('UNKNOWN_DEPENDENCY'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Ambiguous --subtask Origin
// ═══════════════════════════════════════════════════════════════════════════════

describe('guardrail 2 — ambiguous --subtask origin', () => {
  after(uninstallCtxMocks);

  it('returns a structured error (not a throw) when subtask=true but no subtask state exists', () => {
    installCtxMocks({
      state: { status: 'in_progress' },
      subtaskState: null, // no subtask state file
    });

    const { loadEnforcementContext } = require(ENFORCEMENT_CTX_PATH);

    let ctx;
    assert.doesNotThrow(() => {
      ctx = loadEnforcementContext('GH-GUARD-SUBTASK', { subtask: true });
    }, 'must not throw — must return structured error');

    // Error must be present
    assert.ok(ctx.error, 'error descriptor must be present');

    // Error code must match /subtask/i
    assert.equal(typeof ctx.error.code, 'string', 'error.code is a string');
    assert.match(ctx.error.code, /subtask/i, 'error.code must reference subtask');

    // Remediation must be a non-empty array
    assert.ok(Array.isArray(ctx.error.remediation), 'remediation is an array');
    assert.ok(ctx.error.remediation.length > 0, 'remediation must have at least one entry');
    for (const step of ctx.error.remediation) {
      assert.equal(typeof step, 'string', 'each remediation step is a string');
      assert.ok(step.length > 0, 'remediation step is non-empty');
    }

    // Origin must NOT be 'ai-subtask' when ambiguous
    assert.notEqual(ctx.origin, 'ai-subtask', 'ambiguous subtask must not claim ai-subtask origin');

    uninstallCtxMocks();
  });

  it('structured error feeds through preflight to produce a deny with AMBIGUOUS_SUBTASK', () => {
    // Simulate the context that loadEnforcementContext would produce
    const ctx = {
      ticketId: 'GH-GUARD-SUBTASK-PF',
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

    const audited = [];
    const result = runPreflight(ctx, { audit: (e) => audited.push(e) });

    assert.equal(result.allow, false, 'ambiguous subtask must deny');
    assert.ok(result.reasons.includes('AMBIGUOUS_SUBTASK'));
    assert.ok(result.remediation.length >= 2, 'remediation from error must pass through');

    assert.equal(audited.length, 1);
    assert.equal(audited[0].decision, 'deny');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Concurrent Request Index
// ═══════════════════════════════════════════════════════════════════════════════

describe('guardrail 3 — concurrent request index (20 rapid sequential allocations)', () => {
  let TICKET;

  beforeEach(() => {
    TICKET = freshTicket('GUARD-REQIDX');
    cleanupTicket(TICKET);
  });

  it('20 rapid sequential user requests yield strictly monotonic sequences 1..20 with no duplicates', () => {
    const results = [];
    for (let i = 0; i < 20; i++) {
      results.push(requestIndex.nextUserRequest(TICKET));
    }

    // Strictly monotonically increasing
    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i].seq > results[i - 1].seq,
        `sequence not monotonic at index ${i}: ${results[i - 1].seq} >= ${results[i].seq}`
      );
    }

    // No duplicates
    const seqs = results.map((r) => r.seq);
    const uniqueSeqs = new Set(seqs);
    assert.equal(uniqueSeqs.size, 20, 'all 20 sequences must be unique');

    // Values are exactly 1..20
    assert.deepEqual(
      seqs,
      Array.from({ length: 20 }, (_, i) => i + 1)
    );

    // Persistent index reflects final count
    const idx = requestIndex.readIndex(TICKET);
    assert.equal(idx.userSeq, 20, '.request-index.json must reflect final count of 20');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Two PR Workers with Distinct Roots
// ═══════════════════════════════════════════════════════════════════════════════

describe('guardrail 4 — two PR workers with distinct roots + path gate', () => {
  let TICKET;

  beforeEach(() => {
    TICKET = freshTicket('GUARD-PR-WORKERS');
    cleanupTicket(TICKET);
  });

  it('two allocateWorkerSlot calls produce distinct slot numbers (1, 2) and PR1/ PR2/ directories', () => {
    const pr1 = workState.allocateWorkerSlot(TICKET);
    const pr2 = workState.allocateWorkerSlot(TICKET);

    // Distinct slot numbers
    assert.equal(pr1.slot, 1, 'first slot is 1');
    assert.equal(pr2.slot, 2, 'second slot is 2');
    assert.notEqual(pr1.slot, pr2.slot, 'slots must differ');

    // Distinct owner IDs
    assert.equal(pr1.ownerId, 'PR1');
    assert.equal(pr2.ownerId, 'PR2');

    // Both directories exist
    assert.ok(fs.existsSync(pr1.dir), 'PR1/ directory must exist');
    assert.ok(fs.existsSync(pr2.dir), 'PR2/ directory must exist');

    // Directories are distinct
    assert.notEqual(pr1.dir, pr2.dir, 'PR directories must differ');
  });

  it('isWriteAllowedPath allows PR1 to write under PR1/ but denies under PR2/', () => {
    const pr1 = workState.allocateWorkerSlot(TICKET);
    const pr2 = workState.allocateWorkerSlot(TICKET);
    const ticketRoot = path.join(TEMP_TASKS_BASE, TICKET);

    const pr1Paths = {
      prDir: pr1.dir,
      taskDir: path.join(ticketRoot, 'task1'),
      ticketRoot,
    };

    // PR1 can write under its own directory
    assert.ok(
      isWriteAllowedPath(path.join(pr1.dir, 'src', 'index.js'), pr1Paths),
      'PR1 must be allowed to write under PR1/'
    );

    // PR1 cannot write under PR2 directory
    assert.equal(
      isWriteAllowedPath(path.join(pr2.dir, 'src', 'index.js'), pr1Paths),
      false,
      'PR1 must be denied writing under PR2/'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. R18 Remediation Quality — Deny-Path Without a Claim
// ═══════════════════════════════════════════════════════════════════════════════

describe('guardrail 5 — R18 remediation quality (unclaimed task write)', () => {
  it('deny includes a rule ID (SCREAMING_SNAKE_CASE), concrete fix steps mentioning "claim", and audit entry', () => {
    const ctx = {
      ticketId: 'GH-GUARD-R18',
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

    const audited = [];
    // No ownerId = unclaimed task write attempt
    const result = runPreflight(ctx, {
      checks: [createClaimCheck({ taskNum: 1 })],
      audit: (e) => audited.push(e),
    });

    // Must deny
    assert.equal(result.allow, false, 'unclaimed write must deny');

    // Rule ID must be a SCREAMING_SNAKE_CASE string
    assert.ok(result.reasons.length > 0, 'at least one reason must be present');
    for (const ruleId of result.reasons) {
      assert.equal(typeof ruleId, 'string', 'rule ID is a string');
      assert.match(ruleId, /^[A-Z_]+$/, `rule ID "${ruleId}" must match SCREAMING_SNAKE_CASE`);
    }

    // Remediation must include concrete fix steps
    assert.ok(Array.isArray(result.remediation), 'remediation is an array');
    assert.ok(result.remediation.length > 0, 'remediation must have at least one step');
    for (const step of result.remediation) {
      assert.equal(typeof step, 'string', 'each step is a string');
      assert.ok(step.length > 0, 'each step is non-empty');
    }

    // At least one remediation step must mention "claim"
    assert.ok(
      result.remediation.some((r) => r.toLowerCase().includes('claim')),
      `remediation must mention "claim", got: ${JSON.stringify(result.remediation)}`
    );

    // Audit callback receives deny entry with reasons array
    assert.equal(audited.length, 1, 'audit callback invoked exactly once');
    assert.equal(audited[0].decision, 'deny', 'audit entry records deny');
    assert.ok(
      Array.isArray(audited[0].reasons) && audited[0].reasons.length > 0,
      'audit entry must have a non-empty reasons array'
    );
  });
});
