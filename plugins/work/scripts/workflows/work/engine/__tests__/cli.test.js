/**
 * Tests for work/engine/cli.js — GH-339 `cancel` subcommand (Task 6).
 *
 * Uses node:test + node:assert/strict (plugin convention — no Jest/Mocha).
 * The orchestrator CLI is exercised by spawning `work.workflow.js` via
 * child_process (the established plugin pattern — "Tests spawn hook scripts
 * with child_process.spawn to test exit codes"), with env vars set so
 * lib/config resolves TASKS_BASE/WORKTREES_BASE to a temp dir, SESSION_GUARD_DIR
 * to a temp dir, and TICKET_PROVIDER=none so ticket parsing is hermetic.
 *
 * The `cancel` case delegates the state mutation to the work-state `cancel`
 * mutator and the guard release to the session-guard `finish` teardown, both
 * invoked as REAL child processes (this test does not stub them — it is the
 * integration/e2e coverage the gherkin @e2e:task:6 scenarios describe).
 *
 * Run: node --test scripts/workflows/work/engine/__tests__/cli.test.js
 */

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WORK_WORKFLOW_JS = path.join(__dirname, '..', 'work.workflow.js');
const SESSION_GUARD_JS = path.join(__dirname, '..', '..', '..', 'lib', 'hooks', 'session-guard.js');
const { ALL_STEPS, STEP_ORDER } = require(path.join(__dirname, '..', '..', 'step-registry'));

let TEMP_TASKS_BASE;
let TEMP_SESSION_DIR;
const origEnv = { ...process.env };

before(() => {
  TEMP_TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cli-cancel-'));
  TEMP_SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cli-sg-'));
});

after(() => {
  Object.assign(process.env, origEnv);
  for (const dir of [TEMP_TASKS_BASE, TEMP_SESSION_DIR]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

// ─── State helpers ───────────────────────────────────────────────────────────

// Build a realistic work-state where `activeStep` is the current step: every
// prior step 'completed', the active step 'in_progress', the rest 'pending'.
function stateAtStep(ticketId, activeStep) {
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
  };
}

function ticketDir(ticketId) {
  return path.join(TEMP_TASKS_BASE, ticketId);
}

function writeState(ticketId, state) {
  const dir = ticketDir(ticketId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.work-state.json'), JSON.stringify(state, null, 2));
}

function readState(ticketId) {
  const fp = path.join(ticketDir(ticketId), '.work-state.json');
  return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}

function writePlanningArtifact(ticketId, name, body) {
  const dir = ticketDir(ticketId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
}

function sessionFilePath(ticketId) {
  const sanitized = String(ticketId).replace(/[/\\:\0]/g, '_');
  return path.join(TEMP_SESSION_DIR, `claude-session-guard-${sanitized}.json`);
}

function childEnv() {
  return {
    ...process.env,
    TASKS_BASE: TEMP_TASKS_BASE,
    WORKTREES_BASE: TEMP_TASKS_BASE,
    SESSION_GUARD_DIR: TEMP_SESSION_DIR,
    REPO_NAME: 'test',
    TICKET_PROVIDER: 'none',
  };
}

// Spawn `work.workflow.js <args...>` with the temp env.
function runCli(args) {
  return spawnSync(process.execPath, [WORK_WORKFLOW_JS, ...args], {
    encoding: 'utf-8',
    env: childEnv(),
  });
}

// Create a locked session guard file via the sanctioned session-guard init.
function initSessionGuard(ticketId) {
  const res = spawnSync(process.execPath, [SESSION_GUARD_JS, 'init', ticketId, 'work'], {
    encoding: 'utf-8',
    env: childEnv(),
  });
  assert.equal(res.status, 0, `session-guard init must exit 0; stderr=${res.stderr}`);
  assert.ok(fs.existsSync(sessionFilePath(ticketId)), 'session guard file must exist after init');
}

// ─── Scenario 1: cancel during brief phase ───────────────────────────────────

describe('GH-339 orchestrator CLI — cancel subcommand', () => {
  it('orchestrator cancel during brief phase releases the guard and archives artifacts', () => {
    const ticket = 'CANCEL6-BRIEF';
    fs.rmSync(ticketDir(ticket), { recursive: true, force: true });

    writeState(ticket, stateAtStep(ticket, 'brief'));
    writePlanningArtifact(ticket, 'brief.md', '# Brief\nbulk endpoint pattern does not exist\n');
    writePlanningArtifact(ticket, 'spec.md', '# Spec\n');
    initSessionGuard(ticket);

    const res = runCli(['cancel', ticket, '--reason', 'bulk endpoint pattern does not exist']);
    assert.equal(res.status, 0, `cancel at brief must exit 0; stderr=${res.stderr}`);

    // (1) state status becomes cancelled (never completed)
    const persisted = readState(ticket);
    assert.equal(persisted.status, 'cancelled', 'state status must be cancelled');
    assert.notEqual(persisted.status, 'completed', 'must never become completed');
    assert.equal(
      persisted.cancelReason,
      'bulk endpoint pattern does not exist',
      'reason recorded verbatim in state'
    );

    // (2) session guard file removed by the finish teardown
    assert.ok(
      !fs.existsSync(sessionFilePath(ticket)),
      'session guard file must be removed after cancel'
    );

    // (3) brief.md moved under tasks/<TICKET>/archive/
    const archiveDir = path.join(ticketDir(ticket), 'archive');
    assert.ok(fs.existsSync(path.join(archiveDir, 'brief.md')), 'brief.md must be archived');
    assert.ok(
      !fs.existsSync(path.join(ticketDir(ticket), 'brief.md')),
      'brief.md must no longer be at the top of the ticket dir'
    );

    // (4) operator summary line + JSON response reporting ticket/reason/phase/archive
    const out = res.stdout;
    assert.match(out, /cancel/i, 'summary must mention cancellation');
    assert.match(out, /bulk endpoint pattern does not exist/, 'summary must report the reason');
    assert.match(out, /brief/, 'summary must report the phase-at-cancel (brief)');
    assert.match(out, /archive/, 'summary must report the archive location');

    // JSON response shape: { ticket, status:'cancelled', reason, phaseAtCancel, archiveLocation }
    const jsonMatch = out.match(/\{[\s\S]*"status"\s*:\s*"cancelled"[\s\S]*\}/);
    assert.ok(jsonMatch, 'a JSON response with status cancelled must be printed');
    const parsed = JSON.parse(jsonMatch[0]);
    assert.equal(parsed.status, 'cancelled', 'JSON status is cancelled');
    assert.equal(parsed.reason, 'bulk endpoint pattern does not exist', 'JSON reason recorded');
    assert.equal(parsed.phaseAtCancel, 'brief', 'JSON phaseAtCancel is brief');
    assert.ok(parsed.archiveLocation, 'JSON archiveLocation present');

    fs.rmSync(ticketDir(ticket), { recursive: true, force: true });
  });

  // ─── Scenario 2: cancel at implement refuses by default ────────────────────

  it('orchestrator cancel at the implement step refuses by default', () => {
    const ticket = 'CANCEL6-IMPL';
    fs.rmSync(ticketDir(ticket), { recursive: true, force: true });

    writeState(ticket, stateAtStep(ticket, 'implement'));
    writePlanningArtifact(ticket, 'brief.md', '# Brief\n');
    writePlanningArtifact(ticket, 'tasks.md', '# Tasks\n');
    initSessionGuard(ticket);

    const res = runCli(['cancel', ticket, '--reason', 'too late']);

    // Refuse-by-default: exit non-zero without mutating or archiving.
    assert.notEqual(res.status, 0, 'cancel at implement must exit non-zero');

    // AskUserQuestion confirmation that defaults to refusing is surfaced.
    const combined = `${res.stdout}\n${res.stderr}`;
    assert.match(combined, /AskUserQuestion/, 'an AskUserQuestion confirmation must be surfaced');

    // Status stays in_progress — nothing mutated.
    const after = readState(ticket);
    assert.equal(after.status, 'in_progress', 'status must remain in_progress at implement');
    assert.notEqual(after.status, 'cancelled', 'status must not flip to cancelled at implement');

    // Nothing archived.
    assert.ok(
      !fs.existsSync(path.join(ticketDir(ticket), 'archive')),
      'no archive/ directory may be created when cancel is refused'
    );

    // Session guard file untouched (not released).
    assert.ok(
      fs.existsSync(sessionFilePath(ticket)),
      'session guard file must remain when cancel is refused'
    );

    fs.rmSync(ticketDir(ticket), { recursive: true, force: true });
  });

  // ─── Guard: parse/usage failures exit 1 ────────────────────────────────────

  it('exits 1 when --reason is missing', () => {
    const ticket = 'CANCEL6-NOREASON';
    fs.rmSync(ticketDir(ticket), { recursive: true, force: true });
    writeState(ticket, stateAtStep(ticket, 'brief'));

    const res = runCli(['cancel', ticket]);
    assert.equal(res.status, 1, 'missing --reason must exit 1');

    const after = readState(ticket);
    assert.equal(after.status, 'in_progress', 'state untouched when reason missing');
    fs.rmSync(ticketDir(ticket), { recursive: true, force: true });
  });

  it('exits 1 on a ticket parse failure', () => {
    const res = runCli(['cancel', '', '--reason', 'r']);
    assert.equal(res.status, 1, 'ticket parse failure must exit 1');
  });
});
