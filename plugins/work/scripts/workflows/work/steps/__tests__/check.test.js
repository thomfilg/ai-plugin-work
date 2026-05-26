/**
 * Unit tests for the check step module.
 *
 * Run: node --test workflows/work/steps/__tests__/check.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { STEPS } = require('../../step-registry');

function makeAdd() {
  const entries = [];
  const add = (step, action, command, reason, extra) => {
    entries.push({ step, action, command, reason, ...(extra || {}) });
  };
  return { add, entries };
}

function makeCtx(overrides = {}) {
  return {
    STEPS,
    ticket: 'TEST-100',
    rework: false,
    tasksDir: '/tmp/tasks/TEST-100',
    t: 'TEST-100',
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    reports: {},
    allReportsPass: true,
    missingReports: [],
    failedReports: [],
    ...overrides,
  };
}

describe('check step', () => {
  let checkStep;
  before(() => {
    checkStep = require(path.join(__dirname, '..', 'check.js'));
  });

  it('exports a function', () => {
    assert.equal(typeof checkStep, 'function');
  });

  it('RUNs with preCommands when in rework mode', () => {
    const { add, entries } = makeAdd();
    const ctx = makeCtx({ rework: true });
    checkStep(add, makeState(), ctx);
    assert.equal(entries[0].step, STEPS.check);
    assert.equal(entries[0].action, 'RUN');
    assert.match(entries[0].reason, /REWORK/);
    assert.ok(Array.isArray(entries[0].preCommands));
    assert.equal(entries[0].preCommands.length, 4);
    assert.match(entries[0].preCommands[0], /rm -f.*\.check\.md/);
    assert.match(entries[0].preCommands[1], /rm -f.*task\[0-9\]\*.*\.check\.md/);
    assert.match(entries[0].preCommands[2], /\.pr-update-sha/);
    assert.match(entries[0].preCommands[3], /\.post-pr-update-sha/);
  });

  it('DEFERs when all three or more reports pass', () => {
    const { add, entries } = makeAdd();
    const s = makeState({
      reports: { lint: 'PASS', typecheck: 'PASS', test: 'PASS' },
      allReportsPass: true,
    });
    checkStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /RESUME/);
    assert.match(entries[0].reason, /3 reports PASS/);
  });

  it('RUNs when reports exist but not all pass', () => {
    const { add, entries } = makeAdd();
    const s = makeState({
      reports: { lint: 'PASS', typecheck: 'FAIL', test: 'PASS' },
      allReportsPass: false,
      failedReports: ['typecheck'],
    });
    checkStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'RUN');
    assert.match(entries[0].reason, /failed: typecheck/);
  });

  it('RUNs with missing reports listed in reason', () => {
    const { add, entries } = makeAdd();
    const s = makeState({
      reports: {},
      allReportsPass: true,
      missingReports: ['lint', 'typecheck', 'test'],
    });
    checkStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'RUN');
    assert.match(entries[0].reason, /missing: lint, typecheck, test/);
  });

  it('RUNs with default reason when nothing exists', () => {
    const { add, entries } = makeAdd();
    const s = makeState({
      reports: {},
      allReportsPass: true,
      missingReports: [],
      failedReports: [],
    });
    checkStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'RUN');
    assert.match(entries[0].reason, /No reports found/);
  });

  it('RUNs (not DEFERs) when only two reports pass', () => {
    const { add, entries } = makeAdd();
    const s = makeState({
      reports: { lint: 'PASS', typecheck: 'PASS' },
      allReportsPass: true,
    });
    checkStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'RUN');
  });
});
