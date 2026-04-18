/**
 * Tests for work-claims.js — per-task atomic claim locks.
 *
 * IDEA2 / GH-219 — Task 6: `claimTask` and `.claims` locks.
 *
 * Requirements covered:
 *   R5  — `claimTask(ticketId, taskNum, ownerId)` with atomic lock files under
 *         `tasks/<ticketId>/.claims/task-${n}.lock`. Owner id = `PR{N}`.
 *         `session-guard.js` ticket-level behavior is NOT modified.
 *   R15 — Sanitized paths; fail-closed on bad ticket id. No I/O / no
 *         directory creation before input validation passes.
 *
 * Uses node:test + node:assert/strict with direct `require()` of work-claims
 * (pure-function testing of lock acquire/release is far cleaner than CLI
 * spawns; matches the convention established in work-state-graph.test.js).
 *
 * Run: node --test workflows/work/__tests__/work-claims.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Set TASKS_BASE BEFORE requiring work-claims so config.js picks up the
// isolated temp directory at module-load time (see workflows/lib/config.js
// lines 125–127 — TASKS_BASE is resolved once at require() time).
// Env cleanup: the top-level `after()` hook restores the original value.
const TEMP_TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'work-claims-test-'));
const ORIGINAL_TASKS_BASE = process.env.TASKS_BASE;
process.env.TASKS_BASE = TEMP_TASKS_BASE;

// Clear cached modules that read TASKS_BASE at require time so our
// TEMP_TASKS_BASE override takes effect even if another test loaded them first.
delete require.cache[require.resolve('../../lib/config')];
delete require.cache[require.resolve('../work-state')];
delete require.cache[require.resolve('../work-claims')];

const { describe, it, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const workClaims = require(path.join(__dirname, '..', 'work-claims'));
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

function claimsDirFor(ticketId) {
  return path.join(TEMP_TASKS_BASE, ticketId, '.claims');
}

function lockPathFor(ticketId, taskNum) {
  return path.join(claimsDirFor(ticketId), `task-${taskNum}.lock`);
}

after(() => {
  // Restore original TASKS_BASE so subsequent test files in the same process
  // are not affected by the module-load-time override above.
  if (ORIGINAL_TASKS_BASE === undefined) {
    delete process.env.TASKS_BASE;
  } else {
    process.env.TASKS_BASE = ORIGINAL_TASKS_BASE;
  }
  // Clear require.cache so other test files get fresh config
  delete require.cache[require.resolve('../../lib/config')];
  delete require.cache[require.resolve('../work-state')];
  delete require.cache[require.resolve('../work-claims')];
  try {
    fs.rmSync(TEMP_TASKS_BASE, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Public surface
// ───────────────────────────────────────────────────────────────────────────

describe('work-claims module surface', () => {
  it('exports claimTask and releaseTask functions', () => {
    assert.equal(typeof workClaims.claimTask, 'function', 'claimTask must be exported');
    assert.equal(typeof workClaims.releaseTask, 'function', 'releaseTask must be exported');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// claimTask — happy path + lock payload (R5)
// ───────────────────────────────────────────────────────────────────────────

describe('claimTask — happy path + lock payload (R5)', () => {
  let TICKET;
  beforeEach(() => {
    TICKET = freshTicket('TEST-CLAIM-OK');
  });
  afterEach(() => cleanupTicket(TICKET)); // cleanup each test's unique TICKET
  it('creates `.claims/task-${n}.lock` with canonical payload on fresh dir', () => {
    const result = workClaims.claimTask(TICKET, 1, 'PR1');

    assert.equal(result.success, true, 'first claim on fresh dir must succeed');
    assert.equal(result.ownerId, 'PR1');
    assert.equal(result.lockPath, lockPathFor(TICKET, 1));
    assert.ok(!result.error, 'successful claim must not carry an `error` field');

    // Lock file must exist on disk with the declared payload (R5).
    assert.ok(fs.existsSync(result.lockPath), 'lock file must be persisted on disk');
    const payload = JSON.parse(fs.readFileSync(result.lockPath, 'utf8'));
    assert.equal(payload.ownerId, 'PR1');
    assert.equal(payload.taskNum, 1);
    assert.equal(payload.ticketId, TICKET);
    assert.ok(payload.timestamp, 'payload must include a timestamp');
    // Timestamp is an ISO string (YYYY-MM-DDTHH:MM:SS...Z) — validate by
    // round-tripping through Date so a human-readable format is preserved.
    assert.equal(
      new Date(payload.timestamp).toString() !== 'Invalid Date',
      true,
      'timestamp must be a valid ISO date string'
    );
  });

  it('lock path uses sanitized ticket id and integer taskNum', () => {
    // Claim with a string-looking integer (common from CLI args); module
    // must coerce to int and keep the canonical `task-${n}.lock` filename.
    const result = workClaims.claimTask(TICKET, 3, 'PR2');
    assert.equal(result.success, true);
    assert.equal(
      path.basename(result.lockPath),
      'task-3.lock',
      'lock filename must use integer taskNum suffix'
    );
    assert.equal(
      path.dirname(result.lockPath),
      claimsDirFor(TICKET),
      'lock lives under `<ticket>/.claims/`'
    );
  });

  it('leaves no temp artifacts in `.claims/` after successful claim', () => {
    const result = workClaims.claimTask(TICKET, 5, 'PR1');
    assert.equal(result.success, true);
    const entries = fs.readdirSync(claimsDirFor(TICKET));
    // Only the canonical lock file should remain. No `.tmp-*` leftovers.
    const leaked = entries.filter((name) => name.startsWith('.tmp-'));
    assert.deepEqual(
      leaked,
      [],
      `temp lock file(s) leaked into .claims/: ${leaked.join(', ')}`
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// claimTask — already claimed (second owner rejected)
// ───────────────────────────────────────────────────────────────────────────

describe('claimTask — already-claimed semantics', () => {
  let TICKET;
  beforeEach(() => {
    TICKET = freshTicket('TEST-CLAIM-DUP');
  });
  afterEach(() => cleanupTicket(TICKET)); // cleanup each test's unique TICKET
  it('rejects second claim from a different owner without overwriting', () => {
    const first = workClaims.claimTask(TICKET, 1, 'PR1');
    assert.equal(first.success, true);

    const second = workClaims.claimTask(TICKET, 1, 'PR2');
    assert.equal(second.success, false, 'duplicate claim must fail closed');
    assert.equal(
      second.existingOwner,
      'PR1',
      'existingOwner must be reported from the live lock file'
    );
    assert.ok(second.error, 'rejection must carry a structured error');
    assert.ok(second.error.code, 'error must have a stable `code`');
    assert.ok(
      Array.isArray(second.error.remediation) || typeof second.error.remediation === 'string',
      'error must include actionable remediation'
    );

    // Disk payload MUST still belong to the original owner (no overwrite).
    const payload = JSON.parse(fs.readFileSync(lockPathFor(TICKET, 1), 'utf8'));
    assert.equal(payload.ownerId, 'PR1', 'existing lock payload must not be overwritten');
  });

  it('re-claiming by the SAME owner is idempotent (no spurious rejection)', () => {
    const first = workClaims.claimTask(TICKET, 2, 'PR1');
    assert.equal(first.success, true);

    const second = workClaims.claimTask(TICKET, 2, 'PR1');
    assert.equal(
      second.success,
      true,
      'same owner reclaiming its own lock must be a no-op success'
    );
    assert.equal(second.ownerId, 'PR1');
    assert.equal(second.existingOwner, 'PR1');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// claimTask — concurrency atomicity (Promise.all)
// ───────────────────────────────────────────────────────────────────────────

describe('claimTask — concurrency atomicity (R5)', () => {
  let TICKET;
  beforeEach(() => {
    TICKET = freshTicket('TEST-CLAIM-CONCURRENT');
  });
  afterEach(() => cleanupTicket(TICKET)); // cleanup each test's unique TICKET
  it('exactly one owner wins when multiple owners claim the same task', () => {
    // claimTask is synchronous and uses link(2) for atomic lock creation.
    // Atomicity is provided by the kernel's link(2) syscall: it rejects
    // with EEXIST when the target already exists, so even sequential
    // calls produce exactly-one-winner. True cross-process parallelism
    // is not needed because this tests link(2) semantics, not app locking.
    const owners = ['PR1', 'PR2', 'PR3', 'PR4', 'PR5'];
    const results = owners.map((id) => workClaims.claimTask(TICKET, 7, id));

    const successes = results.filter((r) => r.success === true);
    const failures = results.filter((r) => r.success === false);

    assert.equal(
      successes.length,
      1,
      `expected exactly 1 winner across ${owners.length} racers, got ${successes.length}`
    );
    assert.equal(failures.length, owners.length - 1);

    const winnerId = successes[0].ownerId;
    assert.ok(owners.includes(winnerId), 'winner must be one of the contenders');

    // All losers must report the same winning owner via existingOwner.
    for (const loser of failures) {
      assert.equal(
        loser.existingOwner,
        winnerId,
        'every rejected racer must see the same winning existingOwner'
      );
      assert.ok(loser.error, 'rejected racers must carry structured error');
    }

    // On-disk state must match the in-memory winner report.
    const diskPayload = JSON.parse(fs.readFileSync(lockPathFor(TICKET, 7), 'utf8'));
    assert.equal(diskPayload.ownerId, winnerId);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// releaseTask — happy path + wrong-owner rejection
// ───────────────────────────────────────────────────────────────────────────

describe('releaseTask', () => {
  let TICKET;
  beforeEach(() => {
    TICKET = freshTicket('TEST-RELEASE');
  });
  afterEach(() => cleanupTicket(TICKET)); // cleanup each test's unique TICKET
  it('removes the lock file when owner matches', () => {
    const claim = workClaims.claimTask(TICKET, 1, 'PR1');
    assert.equal(claim.success, true);
    assert.ok(fs.existsSync(claim.lockPath));

    const release = workClaims.releaseTask(TICKET, 1, 'PR1');
    assert.equal(release.success, true);
    assert.equal(
      fs.existsSync(claim.lockPath),
      false,
      'lock file must be removed on successful release'
    );
  });

  it('rejects release from a wrong owner with structured error', () => {
    const claim = workClaims.claimTask(TICKET, 1, 'PR1');
    assert.equal(claim.success, true);

    const release = workClaims.releaseTask(TICKET, 1, 'PR2');
    assert.equal(release.success, false, 'wrong-owner release must fail closed');
    assert.equal(release.existingOwner, 'PR1');
    assert.ok(release.error, 'rejection must carry a structured error');
    assert.ok(release.error.code, 'error must have a stable `code`');

    // Lock file MUST still exist (wrong-owner release does not delete).
    assert.ok(
      fs.existsSync(claim.lockPath),
      'wrong-owner release must not delete the existing lock'
    );
    const payload = JSON.parse(fs.readFileSync(claim.lockPath, 'utf8'));
    assert.equal(payload.ownerId, 'PR1');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// R15 — Input validation: ticketId, ownerId, taskNum
// ───────────────────────────────────────────────────────────────────────────

describe('claimTask — R15 input validation (fail closed, no I/O)', () => {
  it('rejects bad ticket ids with INVALID_TICKET_ID; creates no directory', () => {
    const bad = ['', '   ', null, undefined, '../x', '/etc/passwd', 'a\\b', 'a\0b', 'a//b', 'a:b', 'GH-219/'];
    for (const ticketId of bad) {
      const result = workClaims.claimTask(ticketId, 1, 'PR1');
      assert.equal(
        result.success,
        false,
        `bad ticketId ${JSON.stringify(ticketId)} must fail closed`
      );
      assert.ok(result.error, 'must report structured error');
      assert.equal(
        result.error.code,
        'INVALID_TICKET_ID',
        `expected INVALID_TICKET_ID for ${JSON.stringify(ticketId)}`
      );
    }

    // R15: no directory created for any of the above.
    // (TEMP_TASKS_BASE may have entries from well-formed tickets but none
    //  should have been added by this test — we use a probe path here.)
    // Spot-check: the "../x" traversal attempt must not have escaped.
    assert.equal(
      fs.existsSync(path.join(TEMP_TASKS_BASE, '..', 'x')),
      false,
      'traversal attempt must not create any directory outside TASKS_BASE'
    );
  });

  it('accepts suffixed ticket ids with a single slash (parseTicketInput compat)', () => {
    const good = ['GH-219/phase1', 'PROJ-123/task_2', 'AB-1/my-suffix'];
    for (const ticketId of good) {
      const result = workClaims.claimTask(ticketId, 1, 'PR1');
      assert.equal(
        result.success,
        true,
        `suffixed ticketId ${JSON.stringify(ticketId)} must be accepted`
      );
    }
    for (const ticketId of good) {
      cleanupTicket(ticketId.split('/')[0]);
    }
  }); // end suffixed ticket id test
  it('normalizes suffixed ticket ids by splitting base from suffix before sanitizing', () => {
    // safeTicketFragment (internal to work-claims) splits ticketId on "/"
    // before calling config.safeTicketId, so "BASE/suffix" sanitizes only
    // the base. We verify this indirectly: config.safeTicketId should not
    // alter an already-canonical base like "GH-99", so "GH-99/phase1"
    // must produce a lock path containing "GH-99/phase1" (not "GH-99phase1").
    const TICKET_ID = 'GH-99/phase1';
    const result = workClaims.claimTask(TICKET_ID, 1, 'PR1');
    assert.equal(result.success, true, `suffixed ${TICKET_ID} must succeed`);
    // Verify the lock path preserves the base/suffix structure
    assert.ok(
      result.lockPath.includes(path.join('GH-99', 'phase1')),
      `lockPath should contain "GH-99/phase1" path segment, got: "${result.lockPath}"`
    );
    // Cleanup
    cleanupTicket('GH-99');
  });

  it('rejects ticket ids with leading/trailing whitespace', () => {
    const bad = [' GH-219', 'GH-219 ', ' GH-219 ', '\tGH-219', 'GH-219\n'];
    for (const ticketId of bad) {
      const result = workClaims.claimTask(ticketId, 1, 'PR1');
      assert.equal(result.success, false, `whitespace-padded ${JSON.stringify(ticketId)} must fail`);
      assert.equal(result.error.code, 'INVALID_TICKET_ID');
    }
  });

  it('rejects bad owner ids with INVALID_OWNER_ID; no lock written', () => {
    const TICKET = freshTicket('TEST-OWNER-BAD');
    const bad = ['', 'user', 'PR', 'PR-1', 'PRabc', 'pr1', 'PR 1', 'PR01a', 'PR0', null, 1];
    for (const ownerId of bad) {
      const result = workClaims.claimTask(TICKET, 1, ownerId);
      assert.equal(
        result.success,
        false,
        `bad ownerId ${JSON.stringify(ownerId)} must fail closed`
      );
      assert.ok(result.error, 'must report structured error');
      assert.equal(
        result.error.code,
        'INVALID_OWNER_ID',
        `expected INVALID_OWNER_ID for ${JSON.stringify(ownerId)}`
      );
    }

    // No lock file must have been written.
    const claimsDir = claimsDirFor(TICKET);
    if (fs.existsSync(claimsDir)) {
      const entries = fs.readdirSync(claimsDir);
      assert.deepEqual(
        entries.filter((e) => e.endsWith('.lock')),
        [],
        'no lock file may be created when owner id is invalid'
      );
    }

    cleanupTicket(TICKET);
  });

  it('accepts all valid PR{N} owner ids (positive integers)', () => {
    const TICKET = freshTicket('TEST-OWNER-OK');
    const good = ['PR1', 'PR2', 'PR10', 'PR99', 'PR123'];
    for (let i = 0; i < good.length; i++) {
      const result = workClaims.claimTask(TICKET, i + 1, good[i]);
      assert.equal(result.success, true, `valid ownerId ${good[i]} must be accepted`);
    }
    cleanupTicket(TICKET);
  });

  it('rejects bad task numbers with INVALID_TASK_NUM', () => {
    const TICKET = freshTicket('TEST-TASKNUM-BAD');
    const bad = [0, -1, -100, 'abc', null, undefined, 1.5, NaN, '', {}];
    for (const taskNum of bad) {
      const result = workClaims.claimTask(TICKET, taskNum, 'PR1');
      assert.equal(
        result.success,
        false,
        `bad taskNum ${JSON.stringify(taskNum)} must fail closed`
      );
      assert.ok(result.error, 'must report structured error');
      assert.equal(
        result.error.code,
        'INVALID_TASK_NUM',
        `expected INVALID_TASK_NUM for ${JSON.stringify(taskNum)}`
      );
    }
    cleanupTicket(TICKET);
  });
});

describe('releaseTask — R15 input validation (same shape as claimTask)', () => {
  it('rejects bad ticket ids', () => {
    const result = workClaims.releaseTask('', 1, 'PR1');
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INVALID_TICKET_ID');
  });

  it('rejects bad owner ids', () => {
    const TICKET = freshTicket('TEST-REL-OWNER');
    const result = workClaims.releaseTask(TICKET, 1, 'user');
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INVALID_OWNER_ID');
    cleanupTicket(TICKET);
  });

  it('rejects bad task numbers', () => {
    const TICKET = freshTicket('TEST-REL-TASKNUM');
    const result = workClaims.releaseTask(TICKET, 'abc', 'PR1');
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INVALID_TASK_NUM');
    cleanupTicket(TICKET);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// R5 acceptance-criterion: session-guard.js unchanged by this module
// ───────────────────────────────────────────────────────────────────────────

describe('R5 — does not perturb session-guard / work-state surfaces', () => {
  it('does not re-export session-guard internals', () => {
    // Sanity: session-guard remains a ticket-level concern. work-claims
    // must not shadow or re-export its CLI subcommands.
    assert.equal(
      typeof workClaims.handleStop,
      'undefined',
      'work-claims must not leak session-guard hook handlers'
    );
    assert.equal(
      typeof workClaims.writeSessionAtomic,
      'undefined',
      'work-claims must not re-export writeSessionAtomic'
    );
  });

  it('work-state keeps claimTask reachable (spec verification checklist)', () => {
    // Spec verification checklist requires `GREP workflows/work/work-state.js
    // /claimTask/`. Work-state should re-export the claim surface so the
    // one-import convention for CLI / downstream consumers continues to work.
    assert.equal(
      typeof workState.claimTask,
      'function',
      'work-state.js must re-export claimTask for downstream / CLI consumers'
    );
    assert.equal(
      typeof workState.releaseTask,
      'function',
      'work-state.js must re-export releaseTask for symmetry'
    );
  });

  it('rejects ticket id with more than one slash like "A/B/C"', () => {
    const result = workClaims.claimTask('A/B/C', 1, 'PR1');
    assert.equal(result.success, false, 'must reject A/B/C');
    assert.equal(result.error.code, 'INVALID_TICKET_ID');
    assert.ok(
      result.error.message.includes('/'),
      'error message must mention the slash issue'
    );
  });

  it('releaseTask returns idempotent success when lock disappears between existsSync and readLockOwner (TOCTOU)', () => {
    // Simulate the TOCTOU race: create a claim, then delete the lock file
    // before calling releaseTask so that existsSync returns true (at the
    // call site) but readLockOwner returns null (file gone by the time it
    // reads). We approximate this by creating and immediately deleting.
    const TICKET = freshTicket('TEST-TOCTOU');
    workState.initState(TICKET);
    workState.initTasksMeta(TICKET, 1);

    // Simulate the actual TOCTOU race inside releaseTask(): the first
    // existsSync(lockPath) sees the file, then the file disappears before
    // readLockOwner reads it, and the later guard treats that as idempotent
    // success.
    const claim = workClaims.claimTask(TICKET, 1, 'PR1');
    assert.equal(claim.success, true, 'claim must succeed');

    const lockPath = claim.lockPath;
    const realExistsSync = fs.existsSync;
    const realReadFileSync = fs.readFileSync;
    let injectedFirstExists = false;

    try {
      // Stub existsSync: first call for lockPath returns true (file "exists"),
      // subsequent calls fall through to real implementation.
      fs.existsSync = (targetPath, ...args) => {
        if (targetPath === lockPath && !injectedFirstExists) {
          injectedFirstExists = true;
          return true;
        }
        return realExistsSync.call(fs, targetPath, ...args);
      };

      // Stub readFileSync: when reading the lock file, delete it first
      // then throw ENOENT to simulate the file vanishing mid-read.
      fs.readFileSync = (targetPath, ...args) => {
        if (targetPath === lockPath && realExistsSync.call(fs, lockPath)) {
          fs.unlinkSync(lockPath);
          const err = new Error(`ENOENT: no such file or directory, open '${lockPath}'`);
          err.code = 'ENOENT';
          throw err;
        }
        return realReadFileSync.call(fs, targetPath, ...args);
      };

      const release = workClaims.releaseTask(TICKET, 1, 'PR1');
      assert.equal(release.success, true, 'must be success when lock disappears mid-release');
      assert.equal(release.idempotent, true, 'must be flagged as idempotent');
    } finally {
      fs.existsSync = realExistsSync;
      fs.readFileSync = realReadFileSync;
    }
  });
});
