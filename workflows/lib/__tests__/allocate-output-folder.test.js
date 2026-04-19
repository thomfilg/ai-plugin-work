/**
 * Tests for workflows/lib/allocate-output-folder.js (GH-219 Task 9 / R7, R8)
 *
 * Coverage:
 *   - In-flow: returns `TASKS_BASE/<ticket>/task${N}/` for a claimed task.
 *   - Out-of-flow user: returns `user-request-${k}` given a counter from Task 10
 *     (counters are injected — Task 10 will wire the real `.request-index.json`).
 *   - Out-of-flow AI: returns `ai-request-${k}` given a counter.
 *   - Single source of truth for the `task${N}` naming (R7 — one allocator, one
 *     naming policy). Other modules must consume this rather than rebuilding
 *     the segment string.
 *   - R15 fail-closed: rejects invalid ticket IDs (path traversal, empty, null,
 *     backslash) before any filesystem access.
 *   - Legacy-root case: when neither in-flow nor out-of-flow context is
 *     complete enough to allocate, the allocator returns the ticket root as
 *     `kind: 'legacy-root'` so callers can implement the backward-compat
 *     fallback path (pairs with `tdd-phase-state.js` legacy reads).
 *
 * Run with: node --test workflows/lib/__tests__/allocate-output-folder.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const allocator = require('../allocate-output-folder');

function mkTasksBase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alloc-of-'));
  const tasksBase = path.join(dir, 'worktrees', 'tasks');
  fs.mkdirSync(tasksBase, { recursive: true });
  return { dir, tasksBase };
}

describe('allocate-output-folder', () => {
  let tmpDir;
  let tasksBase;
  let origTasksBase;

  beforeEach(() => {
    ({ dir: tmpDir, tasksBase } = mkTasksBase());
    origTasksBase = process.env.TASKS_BASE;
    process.env.TASKS_BASE = tasksBase;
  });

  afterEach(() => {
    if (origTasksBase === undefined) delete process.env.TASKS_BASE;
    else process.env.TASKS_BASE = origTasksBase;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('API surface', () => {
    it('exports allocateOutputFolder, taskSegment, and prefix constants', () => {
      assert.strictEqual(typeof allocator.allocateOutputFolder, 'function');
      assert.strictEqual(typeof allocator.taskSegment, 'function');
      assert.strictEqual(typeof allocator.TASK_SEGMENT_PREFIX, 'string');
      assert.strictEqual(typeof allocator.USER_REQUEST_PREFIX, 'string');
      assert.strictEqual(typeof allocator.AI_REQUEST_PREFIX, 'string');
    });

    it('taskSegment produces the canonical `task${N}` form (R7 single source of truth)', () => {
      assert.strictEqual(allocator.taskSegment(1), 'task1');
      assert.strictEqual(allocator.taskSegment(9), 'task9');
      assert.strictEqual(allocator.taskSegment(42), 'task42');
    });

    it('taskSegment rejects non-positive / non-integer input (fail-closed)', () => {
      assert.throws(() => allocator.taskSegment(0), /Invalid taskNum/i);
      assert.throws(() => allocator.taskSegment(-1), /Invalid taskNum/i);
      assert.throws(() => allocator.taskSegment(1.5), /Invalid taskNum/i);
      assert.throws(() => allocator.taskSegment('abc'), /Invalid taskNum/i);
      assert.throws(() => allocator.taskSegment(null), /Invalid taskNum/i);
    });
  });

  describe('in-flow task allocation (R7, R8)', () => {
    it('returns TASKS_BASE/<ticket>/task${N}/ for in-flow + taskNum', () => {
      const result = allocator.allocateOutputFolder('GH-219', {
        origin: 'workflow',
        flow: 'in-flow',
        taskNum: 9,
        prSlot: 1,
      });
      assert.strictEqual(result.kind, 'in-flow-task');
      assert.strictEqual(result.segment, 'task9');
      assert.strictEqual(result.root, path.join(tasksBase, 'GH-219', 'task9'));
      assert.strictEqual(result.ticketRoot, path.join(tasksBase, 'GH-219'));
    });

    it('is deterministic: same context returns identical segment (R7)', () => {
      const ctx = { origin: 'workflow', flow: 'in-flow', taskNum: 3 };
      const a = allocator.allocateOutputFolder('GH-219', ctx);
      const b = allocator.allocateOutputFolder('GH-219', ctx);
      assert.strictEqual(a.segment, b.segment);
      assert.strictEqual(a.root, b.root);
    });

    it('uses the same taskSegment() helper everywhere (R7 single source of truth)', () => {
      const result = allocator.allocateOutputFolder('GH-219', {
        origin: 'workflow',
        flow: 'in-flow',
        taskNum: 7,
      });
      assert.strictEqual(result.segment, allocator.taskSegment(7));
      assert.ok(result.root.endsWith(path.sep + allocator.taskSegment(7)));
    });

    it('throws when in-flow requires taskNum but none provided (fail-closed)', () => {
      assert.throws(
        () =>
          allocator.allocateOutputFolder('GH-219', {
            origin: 'workflow',
            flow: 'in-flow',
          }),
        /taskNum/i
      );
    });
  });

  describe('out-of-flow allocation (Task 10 will wire counters; stub here)', () => {
    it('returns user-request-${k} when counters are injected', () => {
      const result = allocator.allocateOutputFolder('GH-219', {
        origin: 'user',
        flow: 'out-of-flow',
        counters: { userRequestNext: 4, aiRequestNext: 1 },
      });
      assert.strictEqual(result.kind, 'out-of-flow-user');
      assert.strictEqual(result.segment, 'user-request-4');
      assert.strictEqual(result.root, path.join(tasksBase, 'GH-219', 'user-request-4'));
    });

    it('returns ai-request-${k} when origin is ai-subtask/ai', () => {
      const result = allocator.allocateOutputFolder('GH-219', {
        origin: 'ai-subtask',
        flow: 'out-of-flow',
        counters: { userRequestNext: 1, aiRequestNext: 7 },
      });
      assert.strictEqual(result.kind, 'out-of-flow-ai');
      assert.strictEqual(result.segment, 'ai-request-7');
      assert.strictEqual(result.root, path.join(tasksBase, 'GH-219', 'ai-request-7'));
    });

    it('fails closed when counters are missing for out-of-flow user', () => {
      assert.throws(
        () =>
          allocator.allocateOutputFolder('GH-219', {
            origin: 'user',
            flow: 'out-of-flow',
          }),
        /counter|userRequestNext|Task 10/i
      );
    });

    it('fails closed when counters are missing for out-of-flow ai', () => {
      assert.throws(
        () =>
          allocator.allocateOutputFolder('GH-219', {
            origin: 'ai-subtask',
            flow: 'out-of-flow',
          }),
        /counter|aiRequestNext|Task 10/i
      );
    });
  });

  describe('legacy-root fallback (pairs with tdd-phase-state backward-compat read)', () => {
    it('returns ticket root as kind "legacy-root" when no flow/task context is supplied', () => {
      const result = allocator.allocateOutputFolder('GH-219', {});
      assert.strictEqual(result.kind, 'legacy-root');
      assert.strictEqual(result.segment, null);
      assert.strictEqual(result.root, path.join(tasksBase, 'GH-219'));
    });
  });

  describe('R15 ticket ID validation (fail-closed, before I/O)', () => {
    it('rejects empty / null / undefined ticket id', () => {
      assert.throws(() => allocator.allocateOutputFolder('', { flow: 'in-flow', taskNum: 1 }), /Invalid ticket ID/i);
      assert.throws(() => allocator.allocateOutputFolder(null, { flow: 'in-flow', taskNum: 1 }), /Invalid ticket ID/i);
      assert.throws(() => allocator.allocateOutputFolder(undefined, { flow: 'in-flow', taskNum: 1 }), /Invalid ticket ID/i);
    });

    it('rejects path traversal attempts', () => {
      assert.throws(() => allocator.allocateOutputFolder('../etc', { flow: 'in-flow', taskNum: 1 }), /Invalid ticket ID/i);
      assert.throws(() => allocator.allocateOutputFolder('GH-1/../evil', { flow: 'in-flow', taskNum: 1 }), /Invalid ticket ID/i);
      assert.throws(() => allocator.allocateOutputFolder('foo\\bar', { flow: 'in-flow', taskNum: 1 }), /Invalid ticket ID/i);
    });

    it('rejects bare dot as ticket ID', () => {
      assert.throws(() => allocator.allocateOutputFolder('.', { flow: 'in-flow', taskNum: 1 }), /Invalid ticket ID/i);
      assert.throws(() => allocator.allocateOutputFolder('./', { flow: 'in-flow', taskNum: 1 }), /Invalid ticket ID/i);
    });

    it('handles suffixed ticket IDs with slash separator', () => {
      const result = allocator.allocateOutputFolder('GH-219/phase1', { flow: 'in-flow', taskNum: 1 });
      assert.ok(result.root.includes(path.join('GH-219', 'phase1', 'task1')),
        `root should contain GH-219/phase1/task1, got: ${result.root}`);
    }); // suffix handling verified
    it('rejects ticket IDs with multiple slashes', () => {
      assert.throws(() => allocator.allocateOutputFolder('a/b/c', { flow: 'in-flow', taskNum: 1 }), /at most one/i);
      assert.throws(() => allocator.allocateOutputFolder('https://github.com/org/repo/issues/42', { flow: 'in-flow', taskNum: 1 }), /Invalid ticket ID/i);
    });

    it('rejects leading slash ticket IDs', () => {
      assert.throws(() => allocator.allocateOutputFolder('/etc/passwd', { flow: 'in-flow', taskNum: 1 }), /Invalid ticket ID/i);
    });
  }); // end ticket ID validation

  describe('TASKS_BASE resolution', () => {
    it('uses TASKS_BASE from environment when set', () => {
      // Verify that the resolved base matches what we set
      const result = allocator.allocateOutputFolder('GH-219', { flow: 'in-flow', taskNum: 1 });
      assert.ok(result.root.includes(process.env.TASKS_BASE),
        `root should include TASKS_BASE, got: ${result.root}`);
    });
  });
});
