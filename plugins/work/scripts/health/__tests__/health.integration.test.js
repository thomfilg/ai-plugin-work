/**
 * Integration tests for the `/health` backing script (GH-317 / Task 5).
 *
 * These tests spawn `health.js` as a child process (the established hook-test
 * pattern in this repo) against temp TASKS_BASE / WORKTREES_BASE fixtures and
 * assert on stdout + exit code only. They never reach into module internals,
 * so the implementation is free to refactor.
 *
 * Tagged @task:5. Covers gherkin scenarios:
 *   - /health flags an invalid state file                                  (5.1)
 *   - /health detects an orphaned task dir                                 (5.2)
 *   - /health verifies hook registration count                            (5.3)
 *   - sibling-gated [SKIP] lines for GH-310 / GH-313                       (5.4)
 *   - /health runs strictly read-only without --fix                       (5.5)
 *   - /health --fix removes only genuinely orphaned state, spares live    (5.5)
 *
 * Run with:
 *   node --test scripts/health/__tests__/health.integration.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HEALTH_JS = path.join(__dirname, '..', 'health.js');
const REPO_NAME = 'demo-repo';

const { ALL_STEPS } = require('../../workflows/work/step-registry');

let tmpRoot;
let tasksBase;
let worktreesBase;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gh317-health-'));
  worktreesBase = path.join(tmpRoot, 'worktrees');
  tasksBase = path.join(worktreesBase, 'tasks');
  fs.mkdirSync(tasksBase, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Strip Node's module-loader crash trace from captured output so a not-yet-
 * implemented `health.js` surfaces as a clean behavior failure (empty output,
 * non-zero exit) rather than leaking a "Cannot find module" stack.
 */
function sanitize(text) {
  if (!text) return '';
  if (/Cannot find module|MODULE_NOT_FOUND/.test(text)) return '';
  return text;
}

/** Spawn health.js with the temp config in env; return { status, stdout, stderr }. */
function runHealth(args = [], extraEnv = {}) {
  const res = spawnSync(process.execPath, [HEALTH_JS, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TASKS_BASE: tasksBase,
      WORKTREES_BASE: worktreesBase,
      REPO_NAME,
      ...extraEnv,
    },
  });
  return { ...res, stdout: sanitize(res.stdout), stderr: sanitize(res.stderr) };
}

/** Build the step-status map: steps before `currentStep` completed, rest pending. */
function buildStepStatus(currentName) {
  const idx = ALL_STEPS.indexOf(currentName);
  const stepStatus = {};
  ALL_STEPS.forEach((step, i) => {
    stepStatus[step] = i < idx ? 'completed' : 'pending';
  });
  return stepStatus;
}

/** A fully-valid in-progress state at the implement step. */
function validState(ticket, overrides = {}) {
  return {
    ticketId: ticket,
    currentStep: ALL_STEPS.indexOf('implement') + 1,
    status: 'in_progress',
    stepStatus: buildStepStatus('implement'),
    startTime: '2026-06-22T05:00:00.000Z',
    lastUpdate: '2026-06-22T06:30:00.000Z',
    ...overrides,
  };
}

/** Write a `.work-state.json` for `ticket` under tasksBase; return its dir. */
function writeState(ticket, state) {
  const dir = path.join(tasksBase, ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.work-state.json'), JSON.stringify(state, null, 2));
  return dir;
}

/** Create the worktree dir matching `${REPO_NAME}-${ticket}` for a ticket. */
function makeWorktree(ticket) {
  const wt = path.join(worktreesBase, `${REPO_NAME}-${ticket}`);
  fs.mkdirSync(wt, { recursive: true });
  return wt;
}

describe('health.js — state-file validation (5.1, R6, AC1)', () => {
  it('reports [PASS] for a fully-valid state file', () => {
    writeState('GH-100', validState('GH-100'));
    makeWorktree('GH-100');
    const res = runHealth();
    assert.equal(res.status, 0, `expected exit 0, stderr: ${res.stderr}`);
    assert.match(
      res.stdout,
      /\[PASS\][^\n]*GH-100/,
      'a valid state file must be reported as [PASS] naming the ticket',
    );
  });

  it('flags a state missing startTime as [FAIL] naming the file and the missing key', () => {
    const bad = validState('GH-200');
    delete bad.startTime;
    writeState('GH-200', bad);
    makeWorktree('GH-200');
    const res = runHealth();
    assert.match(
      res.stdout,
      /\[FAIL\][\s\S]*GH-200/,
      'a state missing startTime must be reported as [FAIL] naming the ticket/file',
    );
    assert.match(
      res.stdout,
      /startTime/,
      'the [FAIL] line must name the missing key startTime',
    );
  });

  it('never reports an invalid state file as a false PASS (AC1)', () => {
    const bad = validState('GH-300');
    delete bad.stepStatus;
    writeState('GH-300', bad);
    makeWorktree('GH-300');
    const res = runHealth();
    const gh300Lines = res.stdout.split('\n').filter((l) => /GH-300/.test(l));
    assert.ok(gh300Lines.length > 0, 'GH-300 must be reported');
    assert.ok(
      gh300Lines.every((l) => !/\[PASS\]/.test(l)),
      'an invalid state file must never appear on a [PASS] line',
    );
  });
});

describe('health.js — orphan / stale / dangling detection (5.2, R7, R9)', () => {
  it('flags a task dir whose worktree is absent as an orphan WARN naming the ticket', () => {
    writeState('GH-400', validState('GH-400'));
    // No worktree created for GH-400 -> orphaned task dir.
    const res = runHealth();
    assert.match(
      res.stdout,
      /\[WARN\][\s\S]*GH-400/,
      'an orphaned task dir must be reported as [WARN] naming the ticket',
    );
    assert.match(res.stdout, /orphan/i, 'the WARN line must describe an orphan');
  });

  it('reports a worktree with no live .work.pid and no open PR as stale WARN', () => {
    writeState('GH-500', validState('GH-500'));
    const wt = makeWorktree('GH-500');
    // A .work.pid pointing at a definitely-dead pid -> not live.
    fs.writeFileSync(path.join(wt, '.work.pid'), '9999999');
    const res = runHealth();
    assert.match(
      res.stdout,
      /\[WARN\][\s\S]*GH-500/,
      'a worktree with a dead .work.pid and no open PR must be reported [WARN]',
    );
    assert.match(res.stdout, /stale/i, 'the WARN line must describe a stale worktree');
  });
});

describe('health.js — hook-registration check (5.3, R8)', () => {
  it('reports [PASS] Hooks registered (N/N) when counts match', () => {
    writeState('GH-100', validState('GH-100'));
    makeWorktree('GH-100');
    const res = runHealth();
    assert.match(
      res.stdout,
      /\[PASS\][^\n]*Hooks registered \((\d+)\/\1\)/,
      'matching hook counts must render "[PASS] Hooks registered (N/N)"',
    );
  });
});

describe('health.js — sibling-gated [SKIP] lines (5.4, R12, R14)', () => {
  it('emits [SKIP] Config validation (requires GH-310) when GH-310 is absent', () => {
    const res = runHealth();
    assert.match(
      res.stdout,
      /\[SKIP\][^\n]*Config validation[^\n]*requires GH-310/i,
      'must emit "[SKIP] Config validation (requires GH-310)"',
    );
  });

  it('emits [SKIP] Context (requires GH-313) when GH-313 is absent', () => {
    const res = runHealth();
    assert.match(
      res.stdout,
      /\[SKIP\][^\n]*Context[^\n]*requires GH-313/i,
      'must emit "[SKIP] Context (requires GH-313)"',
    );
  });

  it('does not fail because of the sibling-gated lines', () => {
    writeState('GH-100', validState('GH-100'));
    makeWorktree('GH-100');
    const res = runHealth();
    assert.equal(res.status, 0, `sibling SKIP lines must not fail the run, stderr: ${res.stderr}`);
  });
});

describe('health.js — read-only default (5.5, AC2)', () => {
  it('reports an orphaned dir as WARN only and performs no fs mutation without --fix', () => {
    const orphanDir = writeState('GH-600', validState('GH-600')); // no worktree
    const res = runHealth();
    assert.match(res.stdout, /\[WARN\][\s\S]*GH-600/, 'orphan must be WARN');
    assert.ok(
      fs.existsSync(orphanDir),
      'without --fix the orphaned task dir must be left untouched',
    );
    assert.ok(
      fs.existsSync(path.join(orphanDir, '.work-state.json')),
      'without --fix the orphaned state file must be left untouched',
    );
  });
});

describe('health.js --fix — conservative repair (5.5, R11, AC2)', () => {
  it('removes a genuinely-orphaned task dir and reports the action', () => {
    const orphanDir = writeState('GH-700', validState('GH-700')); // no worktree
    const res = runHealth(['--fix']);
    assert.equal(res.status, 0, `--fix must exit 0, stderr: ${res.stderr}`);
    assert.ok(
      !fs.existsSync(orphanDir),
      'with --fix the genuinely-orphaned task dir must be removed/archived',
    );
    assert.match(
      res.stdout,
      /GH-700/,
      '--fix must report the action taken for the orphaned ticket',
    );
  });

  it('spares a dir with a live .work.pid and an existing worktree', () => {
    const liveDir = writeState('GH-800', validState('GH-800'));
    const wt = makeWorktree('GH-800');
    // A live pid: this very test process is guaranteed alive.
    fs.writeFileSync(path.join(wt, '.work.pid'), String(process.pid));
    const res = runHealth(['--fix']);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(
      fs.existsSync(liveDir),
      'a dir with a live .work.pid + existing worktree must never be removed by --fix',
    );
    assert.ok(
      fs.existsSync(path.join(liveDir, '.work-state.json')),
      'the live-session state file must survive --fix',
    );
  });
});
