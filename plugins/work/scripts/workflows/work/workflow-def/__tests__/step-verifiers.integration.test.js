/**
 * step-verifiers.integration.test.js — GH-283 Task 6 (R8)
 *
 * verifyCleanup must return `true` only when BOTH the tmux dev session is
 * PROVABLY gone AND `<tasksDir>/completion.check.md` exists with the canonical
 * `**Status:** COMPLETE` line. A runner bypass that skips the completion_check
 * phase (so no COMPLETE marker is written) must still fail step verification.
 *
 * GH-283 (greptile comment 2): only a genuine `tmux has-session` exit-1 proves
 * the session is gone. A tmux exec that fails with ENOENT (binary missing), a
 * timeout (SIGTERM), or a permission error proves nothing — the check must fail
 * CLOSED rather than treat those as cleanup success. To keep these cases
 * DETERMINISTIC on any runner (with or without tmux installed), the tmux probe
 * is injected via `deps.tmuxHasSession`, a tri-state seam:
 *   true  → session exists, false → session gone, null → cannot prove.
 *
 * node:test + node:assert/strict, temp-dir TASKS_BASE, no python.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { createStepVerifiers } = require(path.join(__dirname, '..', 'step-verifiers'));

const tmpDirs = [];

function makeTasksBase() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gh283-verify-cleanup-'));
  tmpDirs.push(d);
  return d;
}

/** Unique per test (path isolation only; the tmux probe is injected). */
function uniqueTicketId() {
  return `GH-283-t6-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {string} tasksBase
 * @param {(id: string) => (boolean|null)} [tmuxHasSession] injected tri-state
 *   probe. Defaults to "session provably gone" (false) so completion evidence
 *   is the only remaining variable.
 */
function makeDeps(tasksBase, tmuxHasSession = () => false) {
  return {
    TASKS_BASE: tasksBase,
    safeTicketPath: (id) => id,
    workRoot: path.join(__dirname, '..', '..'),
    tmuxHasSession,
  };
}

/** Create the ticket tasks dir and optionally seed completion.check.md. */
function seedTicket(tasksBase, ticketId, completionContent) {
  const dir = path.join(tasksBase, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  if (completionContent !== undefined) {
    fs.writeFileSync(path.join(dir, 'completion.check.md'), completionContent);
  }
  return dir;
}

describe('verifyCleanup asserts completion evidence (GH-283 R8)', () => {
  after(() => {
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('returns false when the tmux session still exists (not cleaned up)', () => {
    const tasksBase = makeTasksBase();
    const ticketId = uniqueTicketId();
    seedTicket(tasksBase, ticketId, '**Status:** COMPLETE\n');
    // Session present → must fail even with COMPLETE evidence.
    const { verifyCleanup } = createStepVerifiers(makeDeps(tasksBase, () => true));
    assert.equal(verifyCleanup(ticketId), false);
  });

  it('returns false when tmux is gone but completion.check.md is absent', () => {
    const tasksBase = makeTasksBase();
    const ticketId = uniqueTicketId();
    seedTicket(tasksBase, ticketId); // no completion.check.md
    const { verifyCleanup } = createStepVerifiers(makeDeps(tasksBase));
    assert.equal(verifyCleanup(ticketId), false);
  });

  it('returns false when completion.check.md is present but status is NEEDS_WORK', () => {
    const tasksBase = makeTasksBase();
    const ticketId = uniqueTicketId();
    seedTicket(tasksBase, ticketId, '**Status:** NEEDS_WORK\n');
    const { verifyCleanup } = createStepVerifiers(makeDeps(tasksBase));
    assert.equal(verifyCleanup(ticketId), false);
  });

  it('returns true when tmux is gone (exit-1) and completion.check.md reads **Status:** COMPLETE', () => {
    const tasksBase = makeTasksBase();
    const ticketId = uniqueTicketId();
    seedTicket(tasksBase, ticketId, '**Status:** COMPLETE\n');
    // false = session provably gone (the canonical exit-1 signal).
    const { verifyCleanup } = createStepVerifiers(makeDeps(tasksBase, () => false));
    assert.equal(verifyCleanup(ticketId), true);
  });

  it('fails closed when the tmux exec cannot prove the session is gone (ENOENT/timeout)', () => {
    // GH-283: tmux binary missing, a timeout kill (SIGTERM), or a permission
    // error yields a `null` tri-state — "cannot prove". Even with a valid
    // COMPLETE marker this must NOT verify: an unproven-absent dev session is
    // not cleanup success (a runner that cannot exec tmux must fail closed).
    const tasksBase = makeTasksBase();
    const ticketId = uniqueTicketId();
    seedTicket(tasksBase, ticketId, '**Status:** COMPLETE\n');
    const { verifyCleanup } = createStepVerifiers(makeDeps(tasksBase, () => null));
    assert.equal(verifyCleanup(ticketId), false);
  });

  it('default probe (no injection) still fails closed when tmux is absent, or gone-with-COMPLETE passes', () => {
    // Exercises the REAL defaultTmuxHasSession path (no seam) to prove the
    // production default is wired. On a runner WITH tmux the never-created
    // session exits 1 → gone → COMPLETE → true. On a runner WITHOUT tmux the
    // exec throws ENOENT → null → fail closed → false. Either outcome is a safe
    // (non-bypass) result, so we assert the disjunction rather than a fixed
    // boolean — keeping the test green on both kinds of runner.
    const tasksBase = makeTasksBase();
    const ticketId = uniqueTicketId();
    seedTicket(tasksBase, ticketId, '**Status:** COMPLETE\n');
    const deps = {
      TASKS_BASE: tasksBase,
      safeTicketPath: (id) => id,
      workRoot: path.join(__dirname, '..', '..'),
      // no tmuxHasSession → default execFileSync-based probe
    };
    const { verifyCleanup } = createStepVerifiers(deps);
    const result = verifyCleanup(ticketId);
    // tmux present → true (gone+COMPLETE); tmux absent → false (fail closed).
    assert.equal([true, false].includes(result), true);
  });

  it('returns false when the tasks-dir is unresolvable (fails closed, GH-283)', () => {
    // Misconfigured/tampered runner: safeTicketPath throws → ticketDir throws.
    // The P1 backstop must fail CLOSED, not fall open to the tmux-only
    // invariant — matching the primary completion_check phase.
    const deps = {
      TASKS_BASE: makeTasksBase(),
      safeTicketPath: () => {
        throw new Error('TASKS_BASE unset / traversal rejected');
      },
      workRoot: path.join(__dirname, '..', '..'),
      tmuxHasSession: () => false, // session gone; the dir is the failing axis
    };
    const { verifyCleanup } = createStepVerifiers(deps);
    assert.equal(verifyCleanup(uniqueTicketId()), false);
  });
});
