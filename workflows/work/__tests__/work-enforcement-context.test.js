/**
 * Tests for work-enforcement-context.js
 *
 * IDEA2 / GH-219 — Task 2: Enforcement context adapter.
 *
 * Requirements covered:
 *   R1  — gates read `.work-state.json` and parsed `tasks.md` via one shared
 *         adapter; no transcript grep.
 *   R2  — origin ∈ {workflow, ai-subtask, user} derived from observable
 *         signals only; ambiguous `--subtask` does NOT throw — it returns a
 *         structured error descriptor consumable by preflight (Task 3).
 *   R15 — bad ticket id (empty, path-traversal, non-string) is rejected
 *         fail-closed without any filesystem I/O.
 *
 * Uses node:test + node:assert/strict with require.cache injection to stub
 * `loadState` / `loadActiveSubtaskState` / `parseTasks` without touching disk.
 *
 * Run: node --test workflows/work/__tests__/work-enforcement-context.test.js
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Resolve target + dependency paths ONCE to match what the adapter will
// receive from its own `require('./work-state')` / `require('./task-parser')`
// / `require('../lib/config')` calls — same absolute paths are cached.
const MODULE_PATH = path.join(__dirname, '..', 'work-enforcement-context');
const WORK_STATE_PATH = require.resolve(path.join(__dirname, '..', 'work-state'));
const TASK_PARSER_PATH = require.resolve(path.join(__dirname, '..', 'task-parser'));
const CONFIG_PATH = require.resolve(path.join(__dirname, '..', '..', 'lib', 'config'));

// ─── Mock infrastructure ────────────────────────────────────────────────────

/**
 * Install mocks for work-state, task-parser, and config in require.cache.
 * Each mock records every call it receives so individual tests can assert
 * that only the expected functions were hit (e.g. no transcript reads).
 */
function installMocks({ state = null, tasks = null, subtaskState = null, safeId } = {}) {
  const loadStateCalls = [];
  const loadActiveSubtaskStateCalls = [];
  const parseTasksCalls = [];
  const safeTicketIdCalls = [];

  require.cache[WORK_STATE_PATH] = {
    id: WORK_STATE_PATH,
    filename: WORK_STATE_PATH,
    loaded: true,
    exports: {
      loadState: (ticketId) => {
        loadStateCalls.push(ticketId);
        return typeof state === 'function' ? state(ticketId) : state;
      },
      loadActiveSubtaskState: (ticketId) => {
        loadActiveSubtaskStateCalls.push(ticketId);
        return typeof subtaskState === 'function' ? subtaskState(ticketId) : subtaskState;
      },
    },
  };

  require.cache[TASK_PARSER_PATH] = {
    id: TASK_PARSER_PATH,
    filename: TASK_PARSER_PATH,
    loaded: true,
    exports: {
      parseTasks: (tasksDir) => {
        parseTasksCalls.push(tasksDir);
        return typeof tasks === 'function' ? tasks(tasksDir) : tasks;
      },
    },
  };

  require.cache[CONFIG_PATH] = {
    id: CONFIG_PATH,
    filename: CONFIG_PATH,
    loaded: true,
    exports: {
      TASKS_BASE: '/fake/tasks',
      safeTicketId: (id) => {
        safeTicketIdCalls.push(id);
        return typeof safeId === 'function' ? safeId(id) : id;
      },
      tasksDir: (id) => path.join('/fake/tasks', id),
    },
  };

  delete require.cache[require.resolve(MODULE_PATH)];

  return { loadStateCalls, loadActiveSubtaskStateCalls, parseTasksCalls, safeTicketIdCalls };
}

function uninstallMocks() {
  delete require.cache[WORK_STATE_PATH];
  delete require.cache[TASK_PARSER_PATH];
  delete require.cache[CONFIG_PATH];
  delete require.cache[require.resolve(MODULE_PATH)];
}

/**
 * Wrap `fs.readFileSync` and `child_process.execSync` so tests can assert
 * the adapter never reads transcript files and never calls grep. Returns a
 * restore() function that reinstates the originals and a `calls` object
 * with the recorded arguments.
 */
function spyOnIO() {
  const fs = require('fs');
  const cp = require('child_process');
  const origRead = fs.readFileSync;
  const origExec = cp.execSync;
  const calls = { reads: [], execs: [] };

  fs.readFileSync = function (...args) {
    calls.reads.push(String(args[0] ?? ''));
    return origRead.apply(this, args);
  };
  cp.execSync = function (...args) {
    calls.execs.push(String(args[0] ?? ''));
    return origExec.apply(this, args);
  };

  return {
    calls,
    restore() {
      fs.readFileSync = origRead;
      cp.execSync = origExec;
    },
  };
}

// ─── R1 / R2 — Origin derivation ────────────────────────────────────────────

describe('loadEnforcementContext — origin derivation (R1, R2)', () => {
  afterEach(uninstallMocks);

  it('returns origin "workflow" when state.status === "in_progress"', () => {
    installMocks({
      state: { ticketId: 'GH-219', status: 'in_progress', currentStep: 4 },
      tasks: null,
    });

    const { loadEnforcementContext } = require(MODULE_PATH);
    const ctx = loadEnforcementContext('GH-219');

    assert.equal(ctx.origin, 'workflow', 'active workflow state => origin=workflow');
    assert.equal(ctx.hasWorkflow, true, 'hasWorkflow is a boolean signal for hooks');
    assert.equal(ctx.error, null, 'no error for a valid active workflow');
    assert.equal(ctx.state.status, 'in_progress', 'raw state is included for hook consumers');
  });

  it('returns origin "ai-subtask" when --subtask flag AND a resolvable subtask state exists', () => {
    installMocks({
      state: { ticketId: 'GH-219', status: 'completed' },
      subtaskState: {
        ticketId: 'GH-219',
        isSubtask: true,
        parentTicketId: 'GH-219',
        subtaskIndex: 2,
        status: 'in_progress',
      },
    });

    const { loadEnforcementContext } = require(MODULE_PATH);
    const ctx = loadEnforcementContext('GH-219', { subtask: true });

    assert.equal(ctx.origin, 'ai-subtask', '--subtask + resolvable state => origin=ai-subtask');
    assert.equal(ctx.error, null, 'no error when subtask state resolves');
    assert.equal(ctx.subtaskState.subtaskIndex, 2, 'resolved subtask state is exposed for hooks');
    assert.equal(ctx.hasWorkflow, false, 'completed main workflow does not imply workflow origin');
  });

  it('returns origin "user" when there is no active workflow and no subtask flag', () => {
    installMocks({ state: null, tasks: null });

    const { loadEnforcementContext } = require(MODULE_PATH);
    const ctx = loadEnforcementContext('GH-219');

    assert.equal(ctx.origin, 'user', 'default origin is user');
    assert.equal(ctx.hasWorkflow, false);
    assert.equal(ctx.error, null);
  });

  it('treats main state with status !== "in_progress" as non-workflow', () => {
    installMocks({ state: { ticketId: 'GH-219', status: 'completed' } });

    const { loadEnforcementContext } = require(MODULE_PATH);
    const ctx = loadEnforcementContext('GH-219');

    assert.equal(ctx.origin, 'user', 'completed workflow should not produce workflow origin');
  });

  it('never derives origin from caller-supplied fields on options (R15 trust boundary)', () => {
    installMocks({ state: null });

    const { loadEnforcementContext } = require(MODULE_PATH);
    const ctx = loadEnforcementContext('GH-219', {
      // Hostile payload trying to force an origin — adapter must ignore these.
      origin: 'workflow',
      _origin: 'ai-subtask',
    });

    assert.equal(ctx.origin, 'user', 'caller-supplied origin field must not influence derivation');
  });
});

// ─── Ambiguous --subtask (R2 fail-closed, no throw) ─────────────────────────

describe('loadEnforcementContext — ambiguous --subtask (R2)', () => {
  afterEach(uninstallMocks);

  it('returns a structured error descriptor (NOT a throw) when --subtask is set but no subtask state resolves', () => {
    installMocks({
      state: { status: 'in_progress' }, // main workflow active, but flag says subtask
      subtaskState: null, // <-- no resolvable subtask
    });

    const { loadEnforcementContext } = require(MODULE_PATH);

    let ctx;
    assert.doesNotThrow(() => {
      ctx = loadEnforcementContext('GH-219', { subtask: true });
    }, 'ambiguous subtask must not throw — preflight must see a structured payload');

    assert.ok(ctx.error, 'error descriptor is present on ambiguous subtask');
    assert.equal(
      typeof ctx.error.code,
      'string',
      'error.code is a stable string for rule-id routing'
    );
    assert.match(
      ctx.error.code,
      /subtask/i,
      'error.code identifies the ambiguous-subtask rule (consumable by preflight)'
    );
    assert.equal(typeof ctx.error.message, 'string', 'error.message is human-readable');
    assert.ok(Array.isArray(ctx.error.remediation), 'remediation is an array of fix steps');
    assert.ok(
      ctx.error.remediation.length > 0,
      'at least one remediation step is provided (R18 quality)'
    );
  });

  it('does not claim ai-subtask origin when ambiguous — origin is null or user, never ai-subtask', () => {
    installMocks({ state: null, subtaskState: null });

    const { loadEnforcementContext } = require(MODULE_PATH);
    const ctx = loadEnforcementContext('GH-219', { subtask: true });

    assert.notEqual(
      ctx.origin,
      'ai-subtask',
      'ambiguous subtask must NOT be treated as ai-subtask origin'
    );
    assert.ok(ctx.error, 'error descriptor is still present');
  });
});

// ─── R15 — Bad ticket id (fail-closed, no filesystem I/O) ───────────────────

describe('loadEnforcementContext — R15 ticket id validation', () => {
  afterEach(uninstallMocks);

  it('returns a deterministic error for an empty string ticket id', () => {
    installMocks({ state: null });
    const spy = spyOnIO();

    try {
      const { loadEnforcementContext } = require(MODULE_PATH);
      const ctx = loadEnforcementContext('');

      assert.ok(ctx.error, 'empty ticket id yields an error descriptor');
      assert.match(ctx.error.code, /ticket/i, 'error code points at ticket id problem');
      assert.equal(ctx.origin, null, 'no origin derivation for invalid ticket id');
      assert.ok(
        Array.isArray(ctx.error.remediation) && ctx.error.remediation.length > 0,
        'remediation provided for R18 quality bar'
      );

      for (const execCall of spy.calls.execs) {
        assert.ok(
          !/grep/i.test(execCall),
          `no grep calls allowed — saw: ${execCall.slice(0, 120)}`
        );
      }
    } finally {
      spy.restore();
    }
  });

  it('rejects path-traversal characters (.. \\ null bytes) after normalization', () => {
    installMocks({ state: null });

    const { loadEnforcementContext } = require(MODULE_PATH);

    // These contain "..", backslash, or null bytes — rejected after normalization
    for (const bad of ['../../etc', 'GH-219/../secret', 'GH\\219', 'GH-219\u0000x']) {
      const ctx = loadEnforcementContext(bad);
      assert.ok(ctx.error, `path-traversal candidate "${bad}" must be rejected`);
      assert.match(ctx.error.code, /ticket/i);
      assert.equal(ctx.origin, null, 'invalid ticket id yields no origin');
    }
  });

  it('allows slash-containing inputs (e.g. URLs) that normalize to safe IDs', () => {
    // safeTicketId mock normalizes URL-like input to a safe ID
    installMocks({
      state: null,
      safeId: (id) => (id === '/etc/passwd' ? 'etc-passwd' : id),
    });

    const { loadEnforcementContext } = require(MODULE_PATH);
    const ctx = loadEnforcementContext('/etc/passwd');

    // After normalization to "etc-passwd", the ID is safe — no error
    assert.equal(ctx.error, null, 'slash-containing input that normalizes safely should not be rejected');
    assert.equal(ctx.ticketId, 'etc-passwd');
  });

  it('rejects slash-containing inputs whose normalized form is still unsafe', () => {
    // safeTicketId mock returns an unsafe normalized form
    installMocks({
      state: null,
      safeId: (id) => (id === 'foo/../../bar' ? '../bar' : id),
    });

    const { loadEnforcementContext } = require(MODULE_PATH);
    const ctx = loadEnforcementContext('foo/../../bar');

    assert.ok(ctx.error, 'normalized ID with ".." must still be rejected');
    assert.match(ctx.error.code, /ticket/i);
  });

  it('rejects normalized IDs that still contain a forward slash (normalization failure)', () => {
    // safeTicketId mock fails to fully normalize — result still has a slash
    installMocks({
      state: null,
      safeId: (id) => (id === 'bad/input' ? 'still/bad' : id),
    });

    const { loadEnforcementContext } = require(MODULE_PATH);
    const ctx = loadEnforcementContext('bad/input');

    assert.ok(ctx.error, 'normalized ID containing "/" must be rejected');
    assert.match(ctx.error.code, /ticket/i);
    assert.equal(ctx.origin, null, 'invalid ticket id yields no origin');
  });

  it('rejects non-string ticket ids (number, null, undefined, object)', () => {
    installMocks({ state: null });

    const { loadEnforcementContext } = require(MODULE_PATH);

    for (const bad of [null, undefined, 42, {}, []]) {
      const ctx = loadEnforcementContext(bad);
      assert.ok(ctx.error, `non-string ticket id must be rejected: ${JSON.stringify(bad)}`);
      assert.equal(ctx.origin, null);
    }
  });

  it('does not perform any filesystem I/O for an invalid ticket id (fail-closed)', () => {
    const mocks = installMocks({ state: null });
    const spy = spyOnIO();

    try {
      const { loadEnforcementContext } = require(MODULE_PATH);
      const ctx = loadEnforcementContext('../traversal');

      assert.ok(ctx.error, 'invalid id yields error');
      assert.equal(
        mocks.loadStateCalls.length,
        0,
        'loadState MUST NOT be called for invalid ticket id'
      );
      assert.equal(
        mocks.parseTasksCalls.length,
        0,
        'parseTasks MUST NOT be called for invalid ticket id'
      );
      assert.equal(
        mocks.loadActiveSubtaskStateCalls.length,
        0,
        'loadActiveSubtaskState MUST NOT be called for invalid ticket id'
      );
    } finally {
      spy.restore();
    }
  });
});

// ─── R1 — No transcript reads, no grep calls ────────────────────────────────

describe('loadEnforcementContext — no transcript / no grep (R1)', () => {
  afterEach(uninstallMocks);

  it('does not read transcript files and does not invoke grep when resolving origin', () => {
    installMocks({ state: { status: 'in_progress' }, tasks: [], subtaskState: null });
    const spy = spyOnIO();

    try {
      const { loadEnforcementContext } = require(MODULE_PATH);
      const ctx = loadEnforcementContext('GH-219', { subtask: false });

      assert.equal(ctx.origin, 'workflow');

      for (const p of spy.calls.reads) {
        assert.ok(
          !/\.jsonl$/i.test(p),
          `adapter must not read transcript jsonl files — saw: ${p}`
        );
        assert.ok(!/transcript/i.test(p), `adapter must not read transcript files — saw: ${p}`);
      }
      for (const e of spy.calls.execs) {
        assert.ok(!/\bgrep\b/.test(e), `adapter must not call grep — saw: ${e}`);
      }
    } finally {
      spy.restore();
    }
  });

  it('delegates state + tasks reads exclusively through loadState / parseTasks stubs', () => {
    const mocks = installMocks({
      state: { status: 'in_progress' },
      tasks: [{ id: 'task_1', num: 1, dependencies: [] }],
    });

    const { loadEnforcementContext } = require(MODULE_PATH);
    const ctx = loadEnforcementContext('GH-219');

    assert.ok(mocks.loadStateCalls.length > 0, 'adapter must call loadState via work-state.js');
    assert.ok(mocks.parseTasksCalls.length > 0, 'adapter must call parseTasks via task-parser.js');
    assert.ok(Array.isArray(ctx.tasks) && ctx.tasks[0].id === 'task_1', 'tasks are exposed on context');
  });
});

// ─── EnforcementContext shape (Task 3 consumer contract) ────────────────────

describe('loadEnforcementContext — context shape (Task 3 contract)', () => {
  afterEach(uninstallMocks);

  it('exposes a stable shape: { ticketId, origin, state, tasks, subtaskState, hasWorkflow, error, options }', () => {
    installMocks({
      state: { status: 'in_progress', tasksMeta: { totalTasks: 2 } },
      tasks: [{ id: 'task_1', num: 1 }],
    });

    const { loadEnforcementContext } = require(MODULE_PATH);
    const ctx = loadEnforcementContext('GH-219');

    // Keys that Task 3 (preflight) will read
    for (const key of [
      'ticketId',
      'origin',
      'state',
      'tasks',
      'subtaskState',
      'hasWorkflow',
      'error',
      'options',
    ]) {
      assert.ok(key in ctx, `EnforcementContext must expose "${key}" for preflight consumer`);
    }
    assert.equal(ctx.ticketId, 'GH-219', 'ticketId is the sanitized id');
    assert.equal(ctx.options.subtask, false, 'options.subtask is coerced to boolean (undefined → false)');
  });
});
