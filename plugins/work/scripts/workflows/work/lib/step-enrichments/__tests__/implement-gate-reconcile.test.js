/**
 * Regression: implement-gate must reconcile `tasksMeta` with tasks.md when
 * the file has fewer tasks than state (mid-workflow tasks_gate repair).
 *
 * Real-world failure mode (ECHO-4617): tasks.md was edited 3→2 tasks during
 * a tasks_gate repair, but `.work-state.json` kept `task_3: pending`. The
 * implement-gate then looped asking for TDD evidence of a task that no
 * longer existed. The gate now truncates pending tail entries when tasks.md
 * has fewer tasks AND every dropped entry is still pending.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { dispatchAdvanceGate } = require('../implement-gate');

function mkTasksMd(tasksDir, count) {
  fs.mkdirSync(tasksDir, { recursive: true });
  const sections = [];
  for (let i = 1; i <= count; i++) {
    sections.push(
      `## Task ${i} — Sample task ${i}\n\n### Type\nfeature\n\n### Description\nWork item ${i}.\n`
    );
  }
  fs.writeFileSync(path.join(tasksDir, 'tasks.md'), sections.join('\n---\n\n'));
}

function makeDeps(initialState, capturedSaves) {
  return {
    loadWorkState: () => initialState,
    saveWorkState: (_safe, ws) => {
      capturedSaves.push(JSON.parse(JSON.stringify(ws)));
    },
    readTddEvidence: () => null,
    validateTddEvidence: () => ({ valid: false, reason: 'no evidence' }),
    stepName: 'implement',
    workDir: '/tmp',
    log: () => {},
    recursionDepth: 0,
  };
}

describe('implement-gate: reconcile tasksMeta with tasks.md', () => {
  it('drops a pending tail task when tasks.md shrinks 3 → 2', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-reconcile-'));
    try {
      const tasksDir = path.join(tmp, 'ECHO-TEST');
      mkTasksMd(tasksDir, 2); // file has 2 tasks now

      const state = {
        ticketId: 'ECHO-TEST',
        tasksMeta: {
          totalTasks: 3,
          currentTaskIndex: 2,
          tasks: [
            { id: 'task_1', status: 'completed' },
            { id: 'task_2', status: 'completed' },
            { id: 'task_3', status: 'pending' },
          ],
        },
        _tddRetryTask: 3,
        _tddRetryReason: 'stale',
        _tddRetryCount: 1,
      };
      const saves = [];
      dispatchAdvanceGate('ECHO-TEST', { tasksDir }, makeDeps(state, saves));

      assert.equal(saves.length >= 1, true, 'state should be persisted after reconcile');
      const final = saves[0];
      assert.equal(final.tasksMeta.tasks.length, 2);
      assert.equal(final.tasksMeta.totalTasks, 2);
      assert.equal(final._tddRetryTask, undefined);
      assert.equal(final._tddRetryReason, undefined);
      assert.equal(final._tddRetryCount, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to drop a completed tail entry (preserves done work)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-reconcile-'));
    try {
      const tasksDir = path.join(tmp, 'ECHO-TEST');
      mkTasksMd(tasksDir, 1); // file has 1 task

      const state = {
        ticketId: 'ECHO-TEST',
        tasksMeta: {
          totalTasks: 2,
          currentTaskIndex: 1,
          tasks: [
            { id: 'task_1', status: 'completed' },
            { id: 'task_2', status: 'completed' }, // already done — must not be silently dropped
          ],
        },
      };
      const saves = [];
      dispatchAdvanceGate('ECHO-TEST', { tasksDir }, makeDeps(state, saves));

      // No reconcile save expected because tail entry was completed.
      // (Other unrelated saves from the rest of dispatchAdvanceGate may
      // still happen; what matters is tasks.length never shrinks.)
      for (const s of saves) {
        assert.equal(s.tasksMeta.tasks.length, 2, 'completed tail must not be dropped');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('no-op when tasks.md and state agree', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-reconcile-'));
    try {
      const tasksDir = path.join(tmp, 'ECHO-TEST');
      mkTasksMd(tasksDir, 2);

      const state = {
        ticketId: 'ECHO-TEST',
        tasksMeta: {
          totalTasks: 2,
          currentTaskIndex: 2,
          tasks: [
            { id: 'task_1', status: 'completed' },
            { id: 'task_2', status: 'completed' },
          ],
        },
      };
      const saves = [];
      dispatchAdvanceGate('ECHO-TEST', { tasksDir }, makeDeps(state, saves));

      for (const s of saves) {
        assert.equal(s.tasksMeta.tasks.length, 2);
        assert.equal(s.tasksMeta.totalTasks, 2);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
