/**
 * Tests for work-state/steps.js — GH-339 `cancelWork` mutator +
 * `isCancellablePhase` planning-phase boundary.
 *
 * Uses node:test + node:assert/strict (plugin convention — no Jest/Mocha).
 * The module is required in-process with env vars set so lib/config resolves
 * TASKS_BASE to a temp dir; state files are written/read directly, mirroring
 * the completeWork tests in complete-deadlock.test.js.
 *
 * Run: node --test scripts/workflows/work/work-state/__tests__/steps.test.js
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEMP_TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'steps-cancel-test-'));
const { ALL_STEPS, STEP_ORDER } = require(path.join(__dirname, '..', '..', 'step-registry'));

// ─── Module under test (loaded with config env in place) ────────────────────

let steps;
const origEnv = { ...process.env };

before(() => {
  process.env.TASKS_BASE = TEMP_TASKS_BASE;
  process.env.WORKTREES_BASE = TEMP_TASKS_BASE;
  process.env.REPO_NAME = 'test';
  // Force a fresh require so core.js picks up the temp TASKS_BASE.
  delete require.cache[require.resolve('../steps')];
  delete require.cache[require.resolve('../core')];
  steps = require('../steps');
});

after(() => {
  Object.assign(process.env, origEnv);
  try {
    fs.rmSync(TEMP_TASKS_BASE, { recursive: true, force: true });
  } catch {}
});

// ─── State helpers ───────────────────────────────────────────────────────────

// Build a realistic work-state where `activeStep` is the current step: every
// prior step 'completed', the active step 'in_progress', the rest 'pending',
// and currentStep set to the 1-indexed position. This makes "current step"
// unambiguous regardless of how cancelWork derives it (state.currentStep or
// the first in_progress step).
function stateAtStep(ticketId, activeStep, overrides = {}) {
  const activeIndex = STEP_ORDER.indexOf(activeStep);
  assert.ok(activeIndex >= 0, `unknown step: ${activeStep}`);
  const stepStatus = {};
  ALL_STEPS.forEach((step, i) => {
    if (i < activeIndex) stepStatus[step] = 'completed';
    else if (i === activeIndex) stepStatus[step] = 'in_progress';
    else stepStatus[step] = 'pending';
  });
  return {
    ticketId,
    description: '',
    currentStep: activeIndex + 1,
    status: 'in_progress',
    stepStatus,
    checkProgress: {},
    errors: [],
    startTime: new Date().toISOString(),
    lastUpdate: new Date().toISOString(),
    ...overrides,
  };
}

function writeState(ticketId, state) {
  const dir = path.join(TEMP_TASKS_BASE, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.work-state.json'), JSON.stringify(state, null, 2));
}

function readState(ticketId) {
  const fp = path.join(TEMP_TASKS_BASE, ticketId, '.work-state.json');
  return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}

function cleanupTicket(ticketId) {
  try {
    fs.rmSync(path.join(TEMP_TASKS_BASE, ticketId), { recursive: true, force: true });
  } catch {}
}

// ─── isCancellablePhase boundary (Deliverable 1.1) ──────────────────────────

describe('GH-339 isCancellablePhase — planning-phase boundary', () => {
  it('exports isCancellablePhase and CANCELLABLE_STEP_CEILING', () => {
    assert.equal(
      typeof steps.isCancellablePhase,
      'function',
      'isCancellablePhase must be exported'
    );
    assert.equal(
      steps.CANCELLABLE_STEP_CEILING,
      'spec_gate',
      'CANCELLABLE_STEP_CEILING must be the spec_gate ceiling'
    );
  });

  it('is true for planning steps up to and including spec_gate', () => {
    assert.equal(steps.isCancellablePhase('brief'), true, 'brief is cancellable');
    assert.equal(steps.isCancellablePhase('spec_gate'), true, 'spec_gate (ceiling) is cancellable');
  });

  it('is false at tasks and beyond (implement)', () => {
    assert.equal(steps.isCancellablePhase('tasks'), false, 'tasks is NOT cancellable');
    assert.equal(steps.isCancellablePhase('implement'), false, 'implement is NOT cancellable');
  });
});

// ─── cancelWork mutator (Deliverable 1.2) ────────────────────────────────────

describe('GH-339 cancelWork — terminal cancel mutator', () => {
  it('exports cancelWork', () => {
    assert.equal(typeof steps.cancelWork, 'function', 'cancelWork must be exported');
  });

  // Scenario: cancelWork marks state cancelled during a planning phase
  it('marks state cancelled during a planning phase (brief) with reason + ISO time, never completed', () => {
    const ticket = 'CANCEL-BRIEF';
    cleanupTicket(ticket);
    writeState(ticket, stateAtStep(ticket, 'brief'));

    const result = steps.cancelWork(ticket, 'operator abort');
    assert.ok(!result.error, `expected success, got error: ${result.error}`);
    assert.equal(result.status, 'cancelled', 'status must be cancelled');
    assert.notEqual(result.status, 'completed', 'must never become completed');
    assert.equal(result.cancelReason, 'operator abort', 'cancelReason recorded verbatim');
    assert.ok(result.cancelledTime, 'cancelledTime must be set');
    assert.ok(
      !Number.isNaN(Date.parse(result.cancelledTime)),
      `cancelledTime must be an ISO timestamp: ${result.cancelledTime}`
    );

    const persisted = readState(ticket);
    assert.equal(persisted.status, 'cancelled', 'cancelled status must be persisted');
    assert.equal(persisted.cancelReason, 'operator abort', 'reason persisted to state file');
    cleanupTicket(ticket);
  });

  // Scenario: cancelWork is idempotent when already cancelled
  it('is idempotent when already cancelled (returns state unchanged, no error)', () => {
    const ticket = 'CANCEL-IDEMPOTENT';
    cleanupTicket(ticket);
    const already = stateAtStep(ticket, 'brief', {
      status: 'cancelled',
      cancelledTime: '2020-01-01T00:00:00.000Z',
      cancelReason: 'first',
    });
    writeState(ticket, already);

    const result = steps.cancelWork(ticket, 'second');
    assert.ok(!result.error, `idempotent call must not error: ${result.error}`);
    assert.equal(result.status, 'cancelled', 'status stays cancelled');
    assert.equal(result.cancelReason, 'first', 'original reason preserved on idempotent call');
    assert.equal(
      result.cancelledTime,
      '2020-01-01T00:00:00.000Z',
      'original cancelledTime preserved on idempotent call'
    );
    cleanupTicket(ticket);
  });

  // Scenario: cancelWork refuses when the workflow is at the implement step
  it('refuses at the implement step and does not mutate status', () => {
    const ticket = 'CANCEL-IMPLEMENT';
    cleanupTicket(ticket);
    writeState(ticket, stateAtStep(ticket, 'implement'));

    const result = steps.cancelWork(ticket, 'too late');
    assert.ok(result.error, 'must return an error at implement');

    const after = readState(ticket);
    assert.notEqual(after.status, 'cancelled', 'status must not flip to cancelled at implement');
    assert.equal(after.status, 'in_progress', 'status stays in_progress');
    assert.ok(!after.cancelReason, 'no cancelReason stamped on refusal');
    cleanupTicket(ticket);
  });

  // Scenario: cancelWork refuses when the workflow is past spec_gate at tasks
  it('refuses at the tasks step (past spec_gate) and does not mutate status', () => {
    const ticket = 'CANCEL-TASKS';
    cleanupTicket(ticket);
    writeState(ticket, stateAtStep(ticket, 'tasks'));

    const result = steps.cancelWork(ticket, 'too late');
    assert.ok(result.error, 'must return an error at tasks');

    const after = readState(ticket);
    assert.notEqual(after.status, 'cancelled', 'status must not flip to cancelled at tasks');
    assert.equal(after.status, 'in_progress', 'status stays in_progress');
    cleanupTicket(ticket);
  });

  it('returns { error } when no state exists', () => {
    const ticket = 'CANCEL-NO-STATE';
    cleanupTicket(ticket);
    const result = steps.cancelWork(ticket, 'reason');
    assert.ok(result.error, 'must return an error when no state found');
    assert.match(String(result.error), /No state found/i, 'error names missing state');
  });
});
