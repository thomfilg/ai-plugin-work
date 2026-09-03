'use strict';

/**
 * GH-750 flip — the downstream gates in OUTCOME mode (the WORK_TDD_MODE
 * default).
 *
 * Outcome mode records no tdd-phase.json at all: the task-boundary verifier
 * judges each task's commits and records what it could not verify as a flag on
 * the work state. Every gate that demanded recorded phase evidence must
 * therefore either stand down (the pointer state is the proof) or substitute
 * the equivalent outcome-mode check (no unresolved flags) — otherwise the
 * default path blocks every ticket on a file nothing writes.
 *
 * The legacy `process` behavior must be untouched, so each case is asserted in
 * both modes.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { CHECK_GATE_RULES } = require(path.join(__dirname, '..', 'gates', 'check-gate'));
const { createGateVerifiers } = require(
  path.join(__dirname, '..', 'workflow-def', 'gate-verifiers')
);
const { createStepVerifiers } = require(
  path.join(__dirname, '..', 'workflow-def', 'step-verifiers')
);
const { getTaskStatus } = require(path.join(__dirname, '..', 'lib', 'mark-task-progress'));
const { runTransitionGates } = require(path.join(__dirname, '..', 'engine', 'transition-gates'));

const WORK_ROOT = path.join(__dirname, '..');
const TASKS_MD = ['## Task 1 — Only task', '### Type', 'backend', ''].join('\n');

let TASKS_BASE;
const ORIGINAL_MODE = process.env.WORK_TDD_MODE;

before(() => {
  TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-gates-'));
});
after(() => fs.rmSync(TASKS_BASE, { recursive: true, force: true }));
afterEach(() => {
  if (ORIGINAL_MODE === undefined) delete process.env.WORK_TDD_MODE;
  else process.env.WORK_TDD_MODE = ORIGINAL_MODE;
});

let ticketCount = 0;

/**
 * A ticket dir with tasks.md and a work state, and NO tdd-phase.json anywhere
 * — exactly what an outcome-mode ticket looks like on disk.
 */
function makeTicket({ flags = null, completed = true } = {}) {
  const ticketId = `OM-${++ticketCount}`;
  const dir = path.join(TASKS_BASE, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks.md'), TASKS_MD);
  const state = {
    ticketId,
    tasksMeta: {
      currentTaskIndex: completed ? 1 : 0,
      tasks: [{ num: 1, status: completed ? 'completed' : 'pending' }],
    },
  };
  if (flags) state.outcomeFlags = flags;
  fs.writeFileSync(path.join(dir, '.work-state.json'), JSON.stringify(state));
  return { ticketId, dir };
}

const verifierDeps = () => ({
  TASKS_BASE,
  safeTicketPath: (id) => id,
  workRoot: WORK_ROOT,
  resolveGitHead: () => null,
});

describe('check-gate per-task-tdd-evidence rule (GH-750 flip)', () => {
  const rule = CHECK_GATE_RULES.find((r) => r.name === 'per-task-tdd-evidence');

  it('is still registered', () => {
    assert.ok(rule, 'per-task-tdd-evidence rule must exist');
  });

  it('outcome mode: passes with no evidence files when nothing is flagged', () => {
    process.env.WORK_TDD_MODE = 'outcome';
    const { dir } = makeTicket();
    assert.deepEqual(rule.check(dir), []);
  });

  it('outcome mode: blocks on unresolved verifier flags, naming them', () => {
    process.env.WORK_TDD_MODE = 'outcome';
    const { dir } = makeTicket({ flags: [{ task: 1, flags: ['tautological-test'] }] });
    const reasons = rule.check(dir);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /task 1: tautological-test/);
  });

  it('outcome mode: a waived flag no longer blocks', () => {
    process.env.WORK_TDD_MODE = 'outcome';
    const { dir } = makeTicket({
      flags: [{ task: 1, flags: ['runner-unknown'], waived: { by: 'op', reason: 'known gap' } }],
    });
    assert.deepEqual(rule.check(dir), []);
  });

  it('process mode: still demands recorded per-task evidence', () => {
    process.env.WORK_TDD_MODE = 'process';
    const { dir } = makeTicket();
    const reasons = rule.check(dir);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /Missing TDD evidence/);
  });
});

describe('verifyPerTaskTDD (GH-750 flip)', () => {
  it('outcome mode: verified with no evidence files and no flags', () => {
    process.env.WORK_TDD_MODE = 'outcome';
    const { ticketId } = makeTicket();
    assert.equal(createGateVerifiers(verifierDeps()).verifyPerTaskTDD(ticketId), true);
  });

  it('outcome mode: unresolved flags refuse to vouch', () => {
    process.env.WORK_TDD_MODE = 'outcome';
    const { ticketId } = makeTicket({ flags: [{ task: 1, flags: ['no-tests-derived'] }] });
    assert.equal(createGateVerifiers(verifierDeps()).verifyPerTaskTDD(ticketId), false);
  });

  it('process mode: missing evidence refuses to vouch', () => {
    process.env.WORK_TDD_MODE = 'process';
    const { ticketId } = makeTicket();
    assert.equal(createGateVerifiers(verifierDeps()).verifyPerTaskTDD(ticketId), false);
  });
});

describe('verifyImplement (GH-750 flip)', () => {
  it('outcome mode: proven when every task is completed', () => {
    process.env.WORK_TDD_MODE = 'outcome';
    const { ticketId } = makeTicket({ completed: true });
    assert.equal(createStepVerifiers(verifierDeps()).verifyImplement(ticketId), true);
  });

  it('outcome mode: a pending task is not proven', () => {
    process.env.WORK_TDD_MODE = 'outcome';
    const { ticketId } = makeTicket({ completed: false });
    assert.equal(createStepVerifiers(verifierDeps()).verifyImplement(ticketId), false);
  });

  it('outcome mode: refuses to vouch when there is no pointer state at all', () => {
    // Single-task / no-tasksMeta tickets have no boundary to verify AND no
    // evidence artifacts, so nothing proves implement ran — unlike the
    // multi-task gate, absence must not read as proven here.
    process.env.WORK_TDD_MODE = 'outcome';
    const ticketId = `OM-nostate-${process.pid}`;
    fs.mkdirSync(path.join(TASKS_BASE, ticketId), { recursive: true });
    fs.writeFileSync(path.join(TASKS_BASE, ticketId, 'tasks.md'), TASKS_MD);
    assert.equal(createStepVerifiers(verifierDeps()).verifyImplement(ticketId), false);
  });

  it('process mode: unchanged — no tdd-phase.json is not proven', () => {
    process.env.WORK_TDD_MODE = 'process';
    const { ticketId } = makeTicket({ completed: true });
    assert.equal(createStepVerifiers(verifierDeps()).verifyImplement(ticketId), false);
  });
});

describe('implement-exit TDD gate (GH-750 flip)', () => {
  function gateResult(safeTicket) {
    return runTransitionGates({
      deps: {
        TDD_GATED_STEPS: ['implement'],
        STEPS: { implement: 'implement', check: 'check', pr: 'pr' },
        ALL_STEPS: ['implement', 'commit', 'task_review', 'check', 'pr'],
        TASKS_BASE,
        softSteps: new Set(),
        commandMap: [],
        readTddEvidence: () => ({ exists: false, parseError: false, evidence: null }),
      },
      ticket: safeTicket,
      safeTicket,
      ws: null,
      currentStep: 'implement',
      targetStep: 'commit',
      taskNum: 1,
      isForward: true,
      checkDriftDetected: false,
    });
  }

  it('outcome mode: leaving implement is not blocked on missing phase evidence', () => {
    process.env.WORK_TDD_MODE = 'outcome';
    const { ticketId } = makeTicket();
    assert.equal(gateResult(ticketId), null);
  });

  it('process mode: leaving implement still requires evidence', () => {
    process.env.WORK_TDD_MODE = 'process';
    const { ticketId } = makeTicket();
    const result = gateResult(ticketId);
    assert.ok(result && result.error, 'process mode must block');
    assert.match(result.message, /without TDD evidence/);
  });
});

describe('tasks.md checkboxes (GH-750 flip)', () => {
  it('outcome mode: completed status comes from the work state, not evidence', () => {
    process.env.WORK_TDD_MODE = 'outcome';
    const { dir } = makeTicket({ completed: true });
    assert.equal(getTaskStatus(dir, 1), 'completed');
  });

  it('outcome mode: the task the pointer sits on reads in_progress', () => {
    process.env.WORK_TDD_MODE = 'outcome';
    const { dir } = makeTicket({ completed: false });
    assert.equal(getTaskStatus(dir, 1), 'in_progress');
  });

  it('process mode: unchanged — no evidence means not_started', () => {
    process.env.WORK_TDD_MODE = 'process';
    const { dir } = makeTicket({ completed: true });
    assert.equal(getTaskStatus(dir, 1), 'not_started');
  });
});
