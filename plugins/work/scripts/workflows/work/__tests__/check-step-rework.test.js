/**
 * check-step-rework.test.js
 *
 * GH-259 Task 7.3: Tests that check step rework preCommands include
 * per-task *.check.md cleanup pattern.
 *
 * Uses node:test + node:assert/strict.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const checkStep = require('../steps/check');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function collectActions(s, ctx) {
  const actions = [];
  const add = (step, action, tool, reason, opts) => {
    actions.push({ step, action, tool, reason, opts });
  };
  checkStep(add, s, ctx);
  return actions;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('check step: rework preCommands (GH-259 Task 7.3)', () => {
  it('includes per-task *.check.md cleanup in rework preCommands', () => {
    const tasksDir = '/tmp/test-tasks/GH-259';
    const ctx = {
      STEPS: { check: 'check' },
      rework: true,
      tasksDir,
    };
    const actions = collectActions(null, ctx);

    assert.equal(actions.length, 1, 'rework should produce one action');
    const preCommands = actions[0].opts.preCommands;
    assert.ok(Array.isArray(preCommands), 'preCommands should be an array');

    // Existing cleanup: ticket-root *.check.md (e.g. rm -f "${tasksDir}"/*.check.md)
    assert.ok(
      preCommands.some((cmd) => /\*\.check\.md/.test(cmd) && !/task\*/.test(cmd)),
      'should still clean ticket-root *.check.md'
    );

    // New cleanup: per-task *.check.md (e.g. rm -f "${tasksDir}"/task[0-9]*/*.check.md)
    assert.ok(
      preCommands.some((cmd) => /task\[0-9\]\*/.test(cmd) && /\*\.check\.md/.test(cmd)),
      'should clean per-task *.check.md files (task[0-9]*/*.check.md)'
    );
  });

  it('preserves existing pr-update-sha cleanup in rework preCommands', () => {
    const tasksDir = '/tmp/test-tasks/GH-259';
    const ctx = {
      STEPS: { check: 'check' },
      rework: true,
      tasksDir,
    };
    const actions = collectActions(null, ctx);
    const preCommands = actions[0].opts.preCommands;

    assert.ok(
      preCommands.some((cmd) => cmd.includes('.pr-update-sha')),
      'should still clean .pr-update-sha'
    );
    assert.ok(
      preCommands.some((cmd) => cmd.includes('.post-pr-update-sha')),
      'should still clean .post-pr-update-sha'
    );
  });

  it('non-rework mode does not have per-task cleanup', () => {
    const tasksDir = '/tmp/test-tasks/GH-259';
    const ctx = {
      STEPS: { check: 'check' },
      rework: false,
      tasksDir,
    };
    const s = { allReportsPass: false, missingReports: ['tests.check.md'], failedReports: [] };
    const actions = collectActions(s, ctx);

    assert.equal(actions.length, 1);
    assert.equal(actions[0].opts.preCommands, undefined, 'non-rework should have no preCommands');
  });
});
