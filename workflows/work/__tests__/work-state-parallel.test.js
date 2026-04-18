/**
 * Tests for parallel worker PR{N} slot allocation in work-state.js
 *
 * IDEA2 / GH-219 — Task 7: `allocateWorkerSlot` / `releaseWorkerSlot`
 * and the `parallelWorkers: { nextSlot, allocations }` persistence layer.
 *
 * Requirements covered:
 *   R14 — Parallel worker layout `${WORKTREES_BASE}/tasks/<ticketId>/PR{N}/`;
 *         sequential persisted slot allocation. Slot reuse after clean
 *         completion is NOT tested here (monotonic-increment design means
 *         released slots are never recycled; see releaseWorkerSlot tests).
 *   R5  — Owner id binding: PR{N} matches Task 6's owner pattern
 *         `OWNER_ID_RE = /^PR\d+$/` so allocated ids flow directly into
 *         `claimTask(ticketId, taskNum, ownerId)` without translation.
 *   R15 — Sanitized paths; fail-closed on bad ticket id before any FS I/O
 *         (mirrors work-claims.js R15 validation gate).
 *
 * Direct-require pattern (no CLI spawn) keeps the allocator tests fast and
 * allows inspecting the on-disk `.work-state.json` between calls. Matches
 * the convention in `work-state-graph.test.js` and `work-claims.test.js`.
 *
 * Run: node --test workflows/work/__tests__/work-state-parallel.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Set TASKS_BASE BEFORE requiring work-state so config.js picks up the
// isolated temp directory at module-load time (config.TASKS_BASE is
// resolved once at require() time — see workflows/lib/config.js 125–127).
const TEMP_TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'work-state-parallel-test-'));
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
  // Append random suffix so tests in the same process do not collide —
  // direct-require tests share one TASKS_BASE and module state.
  return `${prefix}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

function cleanupTicket(ticketId) {
  try {
    fs.rmSync(path.join(TEMP_TASKS_BASE, ticketId), { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

function prDirFor(ticketId, slot) {
  return path.join(TEMP_TASKS_BASE, ticketId, `PR${slot}`);
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
// Public surface
// ───────────────────────────────────────────────────────────────────────────

describe('work-state parallel worker surface (Task 7)', () => {
  it('exports allocateWorkerSlot and releaseWorkerSlot as functions', () => {
    assert.equal(
      typeof workState.allocateWorkerSlot,
      'function',
      'allocateWorkerSlot must be exported from work-state for downstream consumers'
    );
    assert.equal(
      typeof workState.releaseWorkerSlot,
      'function',
      'releaseWorkerSlot must be exported from work-state (symmetric with claim/release)'
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// allocateWorkerSlot — happy path (sequential, monotonic)
// ───────────────────────────────────────────────────────────────────────────

describe('allocateWorkerSlot — sequential slot assignment (R14)', () => {
  let TICKET;
  beforeEach(() => {
    TICKET = freshTicket('TEST-ALLOC-OK');
    cleanupTicket(TICKET);
  });
  after(() => cleanupTicket(TICKET));

  it('first call returns { slot: 1, ownerId: "PR1", dir: ".../PR1" } and creates the directory', () => {
    const result = workState.allocateWorkerSlot(TICKET);

    assert.ok(result, 'allocateWorkerSlot must return a result object');
    assert.equal(result.success, true, 'successful allocation must return success: true');
    assert.equal(result.slot, 1, 'first allocation must yield slot 1');
    assert.equal(result.ownerId, 'PR1', 'first owner id must be PR1');
    assert.equal(
      result.dir,
      prDirFor(TICKET, 1),
      'first directory must be <TASKS_BASE>/<ticket>/PR1'
    );
    // Directory must exist on disk (R14: sequential persisted slot creates root)
    assert.equal(fs.existsSync(result.dir), true, 'PR{N} directory must exist on disk');
    assert.equal(
      fs.statSync(result.dir).isDirectory(),
      true,
      'PR{N} path must be a directory (not a file / symlink target)'
    );
  });

  it('second allocation returns { slot: 2, ownerId: "PR2" } — distinct from first', () => {
    const first = workState.allocateWorkerSlot(TICKET);
    const second = workState.allocateWorkerSlot(TICKET);

    assert.equal(first.slot, 1);
    assert.equal(second.slot, 2, 'second allocation must yield slot 2');
    assert.equal(second.ownerId, 'PR2');
    assert.equal(second.dir, prDirFor(TICKET, 2));
    assert.notEqual(
      first.slot,
      second.slot,
      'two allocations on the same ticket must produce distinct slot numbers'
    );
    assert.notEqual(
      first.ownerId,
      second.ownerId,
      'two allocations must produce distinct owner ids'
    );
    assert.notEqual(first.dir, second.dir, 'two allocations must produce distinct directories');
    assert.equal(fs.existsSync(second.dir), true, 'second PR{N} directory must exist');
  });

  it('third, fourth, fifth allocations continue the monotonic sequence', () => {
    const slots = [];
    for (let i = 0; i < 5; i++) {
      slots.push(workState.allocateWorkerSlot(TICKET).slot);
    }
    assert.deepEqual(
      slots,
      [1, 2, 3, 4, 5],
      'nextSlot must increment monotonically on every allocation'
    );
  });

  it('ownerId satisfies Task 6 OWNER_ID_RE /^PR\\d+$/ for every allocation', () => {
    const OWNER_ID_RE = /^PR\d+$/;
    for (let i = 0; i < 4; i++) {
      const result = workState.allocateWorkerSlot(TICKET);
      assert.equal(
        OWNER_ID_RE.test(result.ownerId),
        true,
        `allocation #${i + 1} ownerId ${JSON.stringify(
          result.ownerId
        )} must satisfy Task 6's owner regex so it can flow into claimTask`
      );
    }
  });

  it('directory path is absolute and rooted at TASKS_BASE/<ticket>/PR{N}', () => {
    const result = workState.allocateWorkerSlot(TICKET);
    assert.equal(path.isAbsolute(result.dir), true, 'dir must be an absolute path');
    assert.equal(
      result.dir.startsWith(path.join(TEMP_TASKS_BASE, TICKET) + path.sep),
      true,
      'dir must live under <TASKS_BASE>/<ticket>/'
    );
    assert.equal(path.basename(result.dir), `PR${result.slot}`, 'final path segment must be PR{N}');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Persistence — parallelWorkers shape + loadState round-trip
// ───────────────────────────────────────────────────────────────────────────

describe('allocateWorkerSlot — persistence in .work-state.json (R14)', () => {
  let TICKET;
  beforeEach(() => {
    TICKET = freshTicket('TEST-ALLOC-PERSIST');
    cleanupTicket(TICKET);
  });
  after(() => cleanupTicket(TICKET));

  it('persisted `parallelWorkers` field matches { nextSlot, allocations } shape', () => {
    workState.allocateWorkerSlot(TICKET);
    workState.allocateWorkerSlot(TICKET);

    const state = workState.loadState(TICKET);
    assert.ok(state, 'state must exist after allocation');
    assert.ok(state.parallelWorkers, 'state must carry a `parallelWorkers` field');
    assert.equal(
      typeof state.parallelWorkers.nextSlot,
      'number',
      'parallelWorkers.nextSlot must be a number'
    );
    assert.equal(
      Array.isArray(state.parallelWorkers.allocations),
      true,
      'parallelWorkers.allocations must be an array'
    );

    // Shape should ONLY have these two documented fields (no other top-level
    // keys so the data-model reader has a stable contract).
    const extra = Object.keys(state.parallelWorkers).filter(
      (k) => k !== 'nextSlot' && k !== 'allocations'
    );
    assert.deepEqual(
      extra,
      [],
      `parallelWorkers must only contain nextSlot + allocations (extra keys: ${extra.join(', ')})`
    );

    // Every allocation entry must carry the documented fields.
    for (const entry of state.parallelWorkers.allocations) {
      assert.equal(typeof entry.slot, 'number', 'allocation.slot must be a number');
      assert.equal(typeof entry.ownerId, 'string', 'allocation.ownerId must be a string');
      assert.equal(
        /^PR\d+$/.test(entry.ownerId),
        true,
        'allocation.ownerId must satisfy /^PR\\d+$/'
      );
      assert.equal(typeof entry.claimedAt, 'string', 'allocation.claimedAt must be an ISO string');
      assert.equal(
        new Date(entry.claimedAt).toString() !== 'Invalid Date',
        true,
        'allocation.claimedAt must be a valid ISO date'
      );
    }
  });

  it('allocations survive a fresh loadState() round-trip', () => {
    const a = workState.allocateWorkerSlot(TICKET);
    const b = workState.allocateWorkerSlot(TICKET);

    // Fresh loadState() (simulating a new process / context reload)
    const reloaded = workState.loadState(TICKET);
    assert.ok(reloaded && reloaded.parallelWorkers);
    assert.equal(
      reloaded.parallelWorkers.nextSlot,
      3,
      'nextSlot must be persisted so the next allocation yields slot 3'
    );
    assert.equal(
      reloaded.parallelWorkers.allocations.length,
      2,
      'both allocations must survive the round-trip'
    );
    const slots = reloaded.parallelWorkers.allocations.map((x) => x.slot).sort();
    assert.deepEqual(slots, [a.slot, b.slot].sort());
  });

  it('next allocation after reload continues the monotonic sequence', () => {
    workState.allocateWorkerSlot(TICKET);
    workState.allocateWorkerSlot(TICKET);

    // Force a reload by reading and re-requiring the data via loadState.
    // The key assertion is that the third allocation uses nextSlot from disk.
    const third = workState.allocateWorkerSlot(TICKET);
    assert.equal(third.slot, 3, 'third allocation must yield slot 3 (persisted nextSlot)');
    assert.equal(third.ownerId, 'PR3');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// releaseWorkerSlot — marks released, allocation still increments
// ───────────────────────────────────────────────────────────────────────────

describe('releaseWorkerSlot — audit-trail release (R14)', () => {
  let TICKET;
  beforeEach(() => {
    TICKET = freshTicket('TEST-RELEASE');
    cleanupTicket(TICKET);
  });
  after(() => cleanupTicket(TICKET));

  it('marks the allocation entry as released (releasedAt set) without mutating nextSlot', () => {
    const first = workState.allocateWorkerSlot(TICKET);
    assert.equal(first.slot, 1);
    workState.allocateWorkerSlot(TICKET); // slot 2

    const beforeNextSlot = workState.loadState(TICKET).parallelWorkers.nextSlot;

    const release = workState.releaseWorkerSlot(TICKET, 1);
    assert.ok(release, 'releaseWorkerSlot must return a result');
    assert.equal(release.success, true, 'releasing a live slot must succeed');

    const state = workState.loadState(TICKET);
    const entry = state.parallelWorkers.allocations.find((x) => x.slot === 1);
    assert.ok(entry, 'released allocation must remain in the audit trail');
    assert.equal(typeof entry.releasedAt, 'string', 'released allocation must carry releasedAt');
    assert.equal(
      new Date(entry.releasedAt).toString() !== 'Invalid Date',
      true,
      'releasedAt must be a valid ISO date'
    );

    // nextSlot must NOT decrement — release is audit-only (documented choice:
    // monotonic increment; see JSDoc on allocateWorkerSlot).
    assert.equal(
      state.parallelWorkers.nextSlot,
      beforeNextSlot,
      'nextSlot must not decrement on release (monotonic audit trail)'
    );
  });

  it('after release, subsequent allocation continues to increment (does NOT reuse)', () => {
    const first = workState.allocateWorkerSlot(TICKET);
    const second = workState.allocateWorkerSlot(TICKET);
    assert.equal(first.slot, 1);
    assert.equal(second.slot, 2);

    const release = workState.releaseWorkerSlot(TICKET, 1);
    assert.equal(release.success, true);

    // Key behavioural assertion for the "reuse vs increment" decision:
    // nextSlot only grows. The third allocation must be slot 3, NOT slot 1.
    const third = workState.allocateWorkerSlot(TICKET);
    assert.equal(
      third.slot,
      3,
      'after release, next allocation must increment (slot 3), not reuse released slot 1'
    );
    assert.equal(third.ownerId, 'PR3');
  });

  it('releasing an unknown slot returns a structured error without mutating state', () => {
    workState.allocateWorkerSlot(TICKET);

    const release = workState.releaseWorkerSlot(TICKET, 99);
    assert.equal(release.success, false, 'releasing an unknown slot must fail closed');
    assert.ok(release.error, 'failure must carry a structured error');
    assert.equal(typeof release.error.code, 'string', 'error.code must be a stable identifier');

    const state = workState.loadState(TICKET);
    assert.equal(
      state.parallelWorkers.allocations.length,
      1,
      'failed release must not inject a phantom allocation'
    );
    assert.equal(state.parallelWorkers.nextSlot, 2, 'failed release must not mutate nextSlot');
  });

  it('releasing twice is idempotent (second release sees already-released entry)', () => {
    workState.allocateWorkerSlot(TICKET);
    const first = workState.releaseWorkerSlot(TICKET, 1);
    assert.equal(first.success, true);

    const second = workState.releaseWorkerSlot(TICKET, 1);
    // Either success (idempotent) OR a structured error — both are defensible.
    // The contract we lock in: state remains well-formed and no exception is thrown.
    assert.equal(typeof second, 'object');
    assert.ok('success' in second, 'result must include a `success` field');

    const state = workState.loadState(TICKET);
    const entry = state.parallelWorkers.allocations.find((x) => x.slot === 1);
    assert.ok(entry && entry.releasedAt, 'entry must still be marked released');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// R15 — Input validation: fail closed BEFORE any FS I/O
// ───────────────────────────────────────────────────────────────────────────

describe('allocateWorkerSlot — R15 input validation (fail closed, no I/O)', () => {
  it('rejects bad ticket ids with INVALID_TICKET_ID; creates no directory / no state', () => {
    const bad = ['', '   ', null, undefined, '../x', '/etc/passwd', 'a\\b', 'a\0b', 'a//b', 'a:b'];
    for (const ticketId of bad) {
      const result = workState.allocateWorkerSlot(ticketId);
      assert.ok(result, 'even rejected calls must return a result object');
      assert.equal(
        result.success,
        false,
        `bad ticketId ${JSON.stringify(ticketId)} must fail closed`
      );
      assert.ok(result.error, 'rejection must report a structured error');
      assert.equal(
        result.error.code,
        'INVALID_TICKET_ID',
        `expected INVALID_TICKET_ID for ${JSON.stringify(ticketId)}`
      );
      // No `slot` / `ownerId` / `dir` on rejection — these are the success-only
      // fields; keeping them absent prevents callers from accidentally using
      // a partially-populated result.
      assert.equal(result.slot, undefined, 'rejected call must not return a slot');
      assert.equal(result.ownerId, undefined, 'rejected call must not return an ownerId');
      assert.equal(result.dir, undefined, 'rejected call must not return a dir');
    }

    // Traversal probe — "../x" must NOT have created /tmp/.../x outside TASKS_BASE.
    assert.equal(
      fs.existsSync(path.join(TEMP_TASKS_BASE, '..', 'x')),
      false,
      'traversal attempt must not escape TASKS_BASE'
    );
  });

  it('accepts suffixed ticket ids with a single slash (parseTicketInput compat)', () => {
    const good = ['GH-219/phase1', 'PROJ-123/task_2', 'AB-1/my-suffix'];
    for (const ticketId of good) {
      const result = workState.allocateWorkerSlot(ticketId);
      assert.equal(
        result.success !== false,
        true,
        `suffixed ticketId ${JSON.stringify(ticketId)} must be accepted`
      );
      assert.equal(typeof result.slot, 'number', 'accepted ticket must return a slot');
    }
    // Cleanup: suffixed tickets create nested dirs under the base ticket
    for (const ticketId of good) {
      cleanupTicket(ticketId.split('/')[0]);
    }
  });

  it('releaseWorkerSlot also rejects bad ticket ids before touching state', () => {
    const bad = ['', null, '../x'];
    for (const ticketId of bad) {
      const result = workState.releaseWorkerSlot(ticketId, 1);
      assert.equal(result.success, false);
      assert.equal(result.error.code, 'INVALID_TICKET_ID');
    }
  });

  it('releaseWorkerSlot rejects bad slot numbers with structured error', () => {
    const TICKET = freshTicket('TEST-REL-BADSLOT');
    const bad = [0, -1, 'abc', null, undefined, 1.5, NaN, '', {}];
    for (const slot of bad) {
      const result = workState.releaseWorkerSlot(TICKET, slot);
      assert.equal(result.success, false, `bad slot ${JSON.stringify(slot)} must fail closed`);
      assert.ok(result.error, 'must report structured error');
      assert.equal(typeof result.error.code, 'string');
    }
    cleanupTicket(TICKET);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Multi-ticket isolation
// ───────────────────────────────────────────────────────────────────────────

describe('allocateWorkerSlot — per-ticket isolation', () => {
  it('two tickets each start at slot 1 (counters are per-ticket, not global)', () => {
    const T1 = freshTicket('TEST-ISO-A');
    const T2 = freshTicket('TEST-ISO-B');

    const r1a = workState.allocateWorkerSlot(T1);
    const r2a = workState.allocateWorkerSlot(T2);
    assert.equal(r1a.slot, 1, 'ticket A must start at slot 1');
    assert.equal(r2a.slot, 1, 'ticket B must also start at slot 1 (isolated counter)');

    const r1b = workState.allocateWorkerSlot(T1);
    assert.equal(r1b.slot, 2, 'ticket A second allocation must be slot 2');

    const r2b = workState.allocateWorkerSlot(T2);
    assert.equal(r2b.slot, 2, 'ticket B second allocation must be slot 2 (independent)');

    cleanupTicket(T1);
    cleanupTicket(T2);
  });

  it('rejects ticket id with more than one slash like "A/B/C"', () => {
    const result = workState.allocateWorkerSlot('A/B/C');
    assert.ok(result.error, 'must return an error for multiple slashes');
    assert.equal(result.error.code, 'INVALID_TICKET_ID');
    assert.ok(
      result.error.message.includes('/'),
      'error message must mention the slash issue'
    );
  });
});
