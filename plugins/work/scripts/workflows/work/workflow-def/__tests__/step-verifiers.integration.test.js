/**
 * step-verifiers.integration.test.js — GH-283 Task 6 (R8)
 *
 * verifyCleanup must return `true` only when BOTH the tmux dev session is
 * gone AND `<tasksDir>/completion.check.md` exists with the canonical
 * `**Status:** COMPLETE` line. A runner bypass that skips the completion_check
 * phase (so no COMPLETE marker is written) must still fail step verification.
 *
 * We reach the "tmux session gone" state naturally by using a random,
 * never-created ticket id: `tmux has-session -t <id>-dev` exits non-zero,
 * which the verifier reads as "cleaned up". The completion-evidence assertion
 * is then the only thing that can flip the result.
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

/** Unique per test so the tmux dev session provably does not exist. */
function uniqueTicketId() {
  return `GH-283-t6-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeDeps(tasksBase) {
  return {
    TASKS_BASE: tasksBase,
    safeTicketPath: (id) => id,
    workRoot: path.join(__dirname, '..', '..'),
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

  it('returns true when tmux is gone and completion.check.md reads **Status:** COMPLETE', () => {
    const tasksBase = makeTasksBase();
    const ticketId = uniqueTicketId();
    seedTicket(tasksBase, ticketId, '**Status:** COMPLETE\n');
    const { verifyCleanup } = createStepVerifiers(makeDeps(tasksBase));
    assert.equal(verifyCleanup(ticketId), true);
  });
});
