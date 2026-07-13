/**
 * Tests for work-state/cli.js — GH-339 `cancel` CLI handler.
 *
 * Uses node:test + node:assert/strict (plugin convention — no Jest/Mocha).
 * The CLI is exercised by spawning `work-state.js` via child_process (the
 * established plugin pattern — see AGENTS/CLAUDE.md "Tests spawn hook scripts
 * with child_process.spawn to test exit codes"), with env vars set so
 * lib/config resolves TASKS_BASE to a temp dir. State files are written
 * directly, mirroring steps.test.js.
 *
 * Run: node --test scripts/workflows/work/work-state/__tests__/cli.test.js
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEMP_TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cancel-test-'));
const WORK_STATE_JS = path.join(__dirname, '..', '..', 'work-state.js');
const { ALL_STEPS, STEP_ORDER } = require(path.join(__dirname, '..', '..', 'step-registry'));

const origEnv = { ...process.env };

before(() => {
  process.env.TASKS_BASE = TEMP_TASKS_BASE;
  process.env.WORKTREES_BASE = TEMP_TASKS_BASE;
  process.env.REPO_NAME = 'test';
});

after(() => {
  Object.assign(process.env, origEnv);
  try {
    fs.rmSync(TEMP_TASKS_BASE, { recursive: true, force: true });
  } catch {}
});

// ─── State helpers ───────────────────────────────────────────────────────────

// Build a realistic work-state where `activeStep` is the current step: every
// prior step 'completed', the active step 'in_progress', the rest 'pending'.
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

// Spawn `work-state.js <args...>` with the temp TASKS_BASE env.
function runCli(args) {
  return spawnSync(process.execPath, [WORK_STATE_JS, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      TASKS_BASE: TEMP_TASKS_BASE,
      WORKTREES_BASE: TEMP_TASKS_BASE,
      REPO_NAME: 'test',
    },
  });
}

// ─── cancel handler (Deliverable 2.1) ────────────────────────────────────────

describe('GH-339 work-state CLI — cancel handler', () => {
  it('registers `cancel` in the usage/commands string', () => {
    // Invoking with no command prints usage to stderr and exits 1.
    const res = runCli([]);
    assert.equal(res.status, 1, 'no command must exit 1');
    assert.match(res.stderr, /\bcancel\b/, 'usage Commands: line must include cancel');
  });

  it('cancels a planning-phase (brief) ticket: prints cancelled state and exits 0', () => {
    const ticket = 'CLI-CANCEL-BRIEF';
    cleanupTicket(ticket);
    writeState(ticket, stateAtStep(ticket, 'brief'));

    const res = runCli(['cancel', ticket, '--reason', 'operator abort']);
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr=${res.stderr}`);

    const printed = JSON.parse(res.stdout);
    assert.equal(printed.status, 'cancelled', 'printed state status must be cancelled');
    assert.notEqual(printed.status, 'completed', 'must never print completed');
    assert.equal(printed.cancelReason, 'operator abort', 'reason recorded verbatim in output');
    assert.ok(printed.cancelledTime, 'cancelledTime present in printed state');

    const persisted = readState(ticket);
    assert.equal(persisted.status, 'cancelled', 'state file persisted as cancelled');
    assert.equal(persisted.cancelReason, 'operator abort', 'reason persisted to state file');
    cleanupTicket(ticket);
  });

  it('exits 1 with a usage message when --reason is missing', () => {
    const ticket = 'CLI-CANCEL-NOREASON';
    cleanupTicket(ticket);
    writeState(ticket, stateAtStep(ticket, 'brief'));

    const res = runCli(['cancel', ticket]);
    assert.equal(res.status, 1, `missing --reason must exit 1, got ${res.status}`);
    assert.match(res.stderr, /--reason/, 'usage message must mention --reason');

    // Missing reason must NOT mutate the state.
    const after = readState(ticket);
    assert.equal(after.status, 'in_progress', 'state must be untouched when reason missing');
    cleanupTicket(ticket);
  });

  it('exits 1 with the cancelWork error on a non-planning (implement) state', () => {
    const ticket = 'CLI-CANCEL-IMPLEMENT';
    cleanupTicket(ticket);
    writeState(ticket, stateAtStep(ticket, 'implement'));

    const res = runCli(['cancel', ticket, '--reason', 'too late']);
    assert.equal(res.status, 1, `implement-phase cancel must exit 1, got ${res.status}`);
    assert.match(res.stderr, /error/i, 'stderr must carry the cancelWork error');

    const after = readState(ticket);
    assert.notEqual(after.status, 'cancelled', 'status must not flip to cancelled at implement');
    assert.equal(after.status, 'in_progress', 'status stays in_progress');
    cleanupTicket(ticket);
  });
});
