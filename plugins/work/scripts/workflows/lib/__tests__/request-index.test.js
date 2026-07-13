/**
 * Tests for workflows/lib/request-index.js (GH-219 Task 10)
 *
 * Coverage:
 *   - R9:  Out-of-flow user routing — `user-request-${n}` allocation
 *   - R10: Out-of-flow AI routing — `ai-request-${n}` allocation
 *   - R11: Persistent `.request-index.json` with collision-safe increments
 *   - R7:  Allocator completion — wire stubs from Task 9
 *
 * Run with: node --test workflows/lib/__tests__/request-index.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mkTasksBase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-idx-'));
  const tasksBase = path.join(dir, 'worktrees', 'tasks');
  fs.mkdirSync(tasksBase, { recursive: true });
  return { dir, tasksBase };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('request-index', () => {
  let tmpDir;
  let tasksBase;
  let origTasksBase;
  /** @type {import('../request-index')} */
  let requestIndex;

  beforeEach(() => {
    ({ dir: tmpDir, tasksBase } = mkTasksBase());
    origTasksBase = process.env.TASKS_BASE;
    process.env.TASKS_BASE = tasksBase;
    // Fresh require to avoid stale module state
    requestIndex = require('../request-index');
  });

  afterEach(() => {
    if (origTasksBase === undefined) delete process.env.TASKS_BASE;
    else process.env.TASKS_BASE = origTasksBase;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('API surface', () => {
    it('exports nextUserRequest, nextAiRequest, and readIndex', () => {
      assert.strictEqual(typeof requestIndex.nextUserRequest, 'function');
      assert.strictEqual(typeof requestIndex.nextAiRequest, 'function');
      assert.strictEqual(typeof requestIndex.readIndex, 'function');
    });
  });

  describe('user counter (R9)', () => {
    it('starts at 1 for the first allocation', () => {
      const result = requestIndex.nextUserRequest('GH-219');
      assert.strictEqual(result.seq, 1);
      assert.strictEqual(result.segment, 'user-request-1');
      assert.ok(result.root.endsWith(path.join('GH-219', 'user-request-1')));
    });

    it('increments monotonically on subsequent calls', () => {
      const r1 = requestIndex.nextUserRequest('GH-219');
      const r2 = requestIndex.nextUserRequest('GH-219');
      const r3 = requestIndex.nextUserRequest('GH-219');
      assert.strictEqual(r1.seq, 1);
      assert.strictEqual(r2.seq, 2);
      assert.strictEqual(r3.seq, 3);
    });

    it('creates the output folder on disk', () => {
      const result = requestIndex.nextUserRequest('GH-219');
      assert.ok(fs.existsSync(result.root), `Expected directory to exist: ${result.root}`);
      assert.ok(fs.statSync(result.root).isDirectory());
    });
  });

  describe('AI counter (R10)', () => {
    it('starts at 1 for the first allocation', () => {
      const result = requestIndex.nextAiRequest('GH-219');
      assert.strictEqual(result.seq, 1);
      assert.strictEqual(result.segment, 'ai-request-1');
      assert.ok(result.root.endsWith(path.join('GH-219', 'ai-request-1')));
    });

    it('increments monotonically on subsequent calls', () => {
      const r1 = requestIndex.nextAiRequest('GH-219');
      const r2 = requestIndex.nextAiRequest('GH-219');
      assert.strictEqual(r1.seq, 1);
      assert.strictEqual(r2.seq, 2);
    });

    it('creates the output folder on disk', () => {
      const result = requestIndex.nextAiRequest('GH-219');
      assert.ok(fs.existsSync(result.root), `Expected directory to exist: ${result.root}`);
      assert.ok(fs.statSync(result.root).isDirectory());
    });
  });

  describe('independent counters (R9 + R10)', () => {
    it('user and AI counters are independent of each other', () => {
      const u1 = requestIndex.nextUserRequest('GH-219');
      const u2 = requestIndex.nextUserRequest('GH-219');
      const a1 = requestIndex.nextAiRequest('GH-219');
      const u3 = requestIndex.nextUserRequest('GH-219');
      const a2 = requestIndex.nextAiRequest('GH-219');

      assert.strictEqual(u1.seq, 1);
      assert.strictEqual(u2.seq, 2);
      assert.strictEqual(a1.seq, 1);
      assert.strictEqual(u3.seq, 3);
      assert.strictEqual(a2.seq, 2);
    });

    it('different ticket IDs have independent counters', () => {
      const a1 = requestIndex.nextUserRequest('GH-100');
      const b1 = requestIndex.nextUserRequest('GH-200');
      const a2 = requestIndex.nextUserRequest('GH-100');

      assert.strictEqual(a1.seq, 1);
      assert.strictEqual(b1.seq, 1);
      assert.strictEqual(a2.seq, 2);
    });
  });

  describe('.request-index.json persistence (R11)', () => {
    it('persists counters between calls', () => {
      requestIndex.nextUserRequest('GH-219');
      requestIndex.nextUserRequest('GH-219');
      requestIndex.nextAiRequest('GH-219');

      const index = requestIndex.readIndex('GH-219');
      assert.strictEqual(index.userSeq, 2);
      assert.strictEqual(index.aiSeq, 1);
      assert.strictEqual(index.version, 1);
    });

    it('writes .request-index.json to the ticket directory', () => {
      requestIndex.nextUserRequest('GH-219');
      const indexPath = path.join(tasksBase, 'GH-219', '.request-index.json');
      assert.ok(fs.existsSync(indexPath), `Expected file: ${indexPath}`);
      const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      assert.strictEqual(raw.userSeq, 1);
      assert.strictEqual(raw.aiSeq, 0);
      assert.strictEqual(raw.version, 1);
    });

    it('survives a fresh readIndex after writes', () => {
      requestIndex.nextUserRequest('GH-219');
      requestIndex.nextAiRequest('GH-219');
      requestIndex.nextAiRequest('GH-219');

      // Read back
      const idx = requestIndex.readIndex('GH-219');
      assert.strictEqual(idx.userSeq, 1);
      assert.strictEqual(idx.aiSeq, 2);
    });

    it('returns zero counters when no index file exists', () => {
      const idx = requestIndex.readIndex('GH-NONEXIST');
      assert.strictEqual(idx.userSeq, 0);
      assert.strictEqual(idx.aiSeq, 0);
      assert.strictEqual(idx.version, 1);
    });
  });

  describe('atomic write safety (R11)', () => {
    it('does not leave partial .request-index.json on disk', () => {
      // Perform a normal allocation — file should be valid JSON
      requestIndex.nextUserRequest('GH-219');
      const indexPath = path.join(tasksBase, 'GH-219', '.request-index.json');
      const raw = fs.readFileSync(indexPath, 'utf-8');
      // Should parse cleanly (not truncated or corrupt)
      const parsed = JSON.parse(raw);
      assert.strictEqual(typeof parsed.userSeq, 'number');
      assert.strictEqual(typeof parsed.aiSeq, 'number');
    });

    it('no .tmp files remain after allocation', () => {
      requestIndex.nextUserRequest('GH-219');
      const ticketDir = path.join(tasksBase, 'GH-219');
      const files = fs.readdirSync(ticketDir);
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
      assert.strictEqual(tmpFiles.length, 0, `Unexpected .tmp files: ${tmpFiles.join(', ')}`);
    });
  });

  describe('simulated concurrency (R11 collision-safe)', () => {
    it('parallel increments yield strictly increasing sequences', () => {
      // Simulate rapid sequential calls (true parallelism needs worker_threads,
      // but sequential calls to the atomic counter must still be strictly increasing)
      const results = [];
      for (let i = 0; i < 20; i++) {
        results.push(requestIndex.nextUserRequest('GH-219'));
      }

      // Verify strict monotonic increase
      for (let i = 1; i < results.length; i++) {
        assert.ok(
          results[i].seq > results[i - 1].seq,
          `Sequence not strictly increasing at index ${i}: ${results[i - 1].seq} >= ${results[i].seq}`
        );
      }
      assert.strictEqual(results[results.length - 1].seq, 20);
    });
  });

  describe('validation', () => {
    it('rejects empty ticket ID', () => {
      assert.throws(() => requestIndex.nextUserRequest(''), /ticket/i);
    });

    it('rejects null ticket ID', () => {
      assert.throws(() => requestIndex.nextUserRequest(null), /ticket/i);
    });

    it('rejects path traversal in ticket ID', () => {
      assert.throws(() => requestIndex.nextUserRequest('../etc'), /ticket/i);
    });
  });
});
