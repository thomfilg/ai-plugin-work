/**
 * Step-level tests for check 4_run_tests (GH-394): crash-vs-fail reporting,
 * flake-aware single retry (FLAKY = pass with warning), baseline net-new vs
 * pre-existing split, and the canonical `**Status:**` report line.
 *
 * Drives the real step handler through tier-0 (SCRIPT_RUN_AFFECTED_UNIT)
 * pointing at fixture shell scripts that emit real-ish runner output.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registerRunTests = require('../lib/steps/run-tests');
const { BASELINE_FILE } = require('../lib/tests-baseline');

let handler;
registerRunTests((name, fn) => {
  assert.equal(name, '4_run_tests');
  handler = fn;
});

const ENV_KEYS = [
  'SCRIPT_RUN_AFFECTED_UNIT',
  'SCRIPT_RUN_AFFECTED_INTEGRATION',
  'SCRIPT_RUN_AFFECTED_E2E',
  'CHECK_FLAKE_RETRY',
  'CHECK_FLAKE_RETRY_MAX',
  'CHECK_TESTS_BASELINE',
];

let dir;
let originalCwd;
let savedEnv;

beforeEach(() => {
  originalCwd = process.cwd();
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-step-'));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeScript(name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/usr/bin/env bash\necho run >> "${dir}/calls.log"\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return `bash "${p}"`;
}

function callCount() {
  try {
    return fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').length;
  } catch {
    return 0;
  }
}

function runStep() {
  const state = { setupResult: { reportFolder: dir }, changesHash: 'abc123', ticketId: 'T-1' };
  const ctx = { tasksDir: dir, checkHooksDir: dir };
  const result = handler(state, ctx);
  const report = fs.readFileSync(path.join(dir, 'tests.check.md'), 'utf8');
  return { result, report, state };
}

describe('4_run_tests — PASSED', () => {
  it('green run → auto-advance, **Status:** APPROVED, Result PASSED, baseline written', () => {
    process.env.SCRIPT_RUN_AFFECTED_UNIT = makeScript(
      'pass.sh',
      'echo " Tests  42 passed (42)"; exit 0'
    );
    const { result, report } = runStep();
    assert.equal(result, null);
    assert.match(report, /\*\*Status:\*\* APPROVED/);
    assert.match(report, /\*\*Result:\*\* PASSED/);
    assert.ok(fs.existsSync(path.join(dir, BASELINE_FILE)), 'green baseline recorded');
    assert.equal(callCount(), 1, 'no retry on green');
  });
});

describe('4_run_tests — CRASHED (echo-4491-003)', () => {
  it('all-pass + OOM + nonzero exit → CRASHED with quoted signature, no retry, distinct reason', () => {
    process.env.SCRIPT_RUN_AFFECTED_UNIT = makeScript(
      'crash.sh',
      [
        'echo " Tests  8250 passed | 3 skipped (8253)"',
        'echo "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory"',
        'exit 134',
      ].join('\n')
    );
    const { result, report } = runStep();
    assert.ok(result, 'blocks');
    assert.equal(result.action, 'failed');
    assert.match(result.reason, /CRASHED/);
    assert.match(result.reason, /JavaScript heap out of memory/);
    assert.doesNotMatch(result.reason, /test(s)? failing/i, 'never reported as failing tests');
    assert.match(report, /\*\*Status:\*\* NEEDS_WORK/);
    assert.match(report, /\*\*Result:\*\* CRASHED/);
    assert.match(report, /## Crash Signature/);
    assert.match(report, /> ".*JavaScript heap out of memory.*"/);
    assert.equal(callCount(), 1, 'crashes are NEVER retried');
    assert.equal(
      fs.existsSync(path.join(dir, BASELINE_FILE)),
      false,
      'no baseline from a crashed run'
    );
  });

  it('0 tests executed + nonzero exit → CRASHED (M === 0 guard), never "all tests failed"', () => {
    process.env.SCRIPT_RUN_AFFECTED_UNIT = makeScript(
      'zero.sh',
      'echo "# tests 0"; echo "# pass 0"; echo "# fail 0"; exit 1'
    );
    const { result, report } = runStep();
    assert.equal(result.action, 'failed');
    assert.match(report, /\*\*Result:\*\* CRASHED/);
    assert.match(report, /0 tests executed/);
    assert.equal(callCount(), 1);
  });
});

describe('4_run_tests — FLAKY retry (echo-4492-001)', () => {
  it('small failing set that passes on retry → FLAKY, APPROVED with warning + flaky list', () => {
    process.env.SCRIPT_RUN_AFFECTED_UNIT = makeScript(
      'flaky.sh',
      [
        `if [ -f "${dir}/marker" ]; then`,
        '  echo " Tests  5 passed (5)"; exit 0',
        'else',
        `  touch "${dir}/marker"`,
        '  echo " FAIL  scripts/setup-db.integration.test.ts > setup > loads seed data"',
        '  echo "Error: Test timed out in 30000ms."',
        '  echo " Tests  1 failed | 4 passed (5)"',
        '  exit 1',
        'fi',
      ].join('\n')
    );
    const { result, report } = runStep();
    assert.equal(result, null, 'flaky pass advances');
    assert.match(report, /\*\*Status:\*\* APPROVED/);
    assert.match(report, /\*\*Result:\*\* FLAKY/);
    assert.match(report, /## Flaky \(passed on retry\)/);
    assert.match(report, /scripts\/setup-db\.integration\.test\.ts > setup > loads seed data/);
    assert.equal(callCount(), 2, 'exactly one retry round');
  });

  it('persistent failure → retried once, still NEEDS_WORK/FAILED (cap: one round)', () => {
    process.env.SCRIPT_RUN_AFFECTED_UNIT = makeScript(
      'fail.sh',
      [
        'echo " FAIL  src/a.test.ts > a > broken"',
        'echo "AssertionError: expected 1 to equal 2"',
        'echo " Tests  1 failed | 4 passed (5)"',
        'exit 1',
      ].join('\n')
    );
    const { result, report } = runStep();
    assert.equal(result.action, 'failed');
    assert.match(result.reason, /Tests failed/);
    assert.match(report, /\*\*Status:\*\* NEEDS_WORK/);
    assert.match(report, /\*\*Result:\*\* FAILED/);
    assert.match(report, /retried once, still failing/);
    assert.equal(callCount(), 2, 'capped at one retry round');
  });

  it('large failing set (> max, no transient signature) → no retry', () => {
    const fails = Array.from({ length: 7 }, (_, i) => `echo " FAIL  src/x.test.ts > x > t${i}"`);
    process.env.SCRIPT_RUN_AFFECTED_UNIT = makeScript(
      'many.sh',
      [...fails, 'echo " Tests  7 failed | 10 passed (17)"', 'exit 1'].join('\n')
    );
    const { result } = runStep();
    assert.equal(result.action, 'failed');
    assert.equal(callCount(), 1, 'not retry-eligible');
  });

  it('CHECK_FLAKE_RETRY=0 disables retries', () => {
    process.env.CHECK_FLAKE_RETRY = '0';
    process.env.SCRIPT_RUN_AFFECTED_UNIT = makeScript(
      'once.sh',
      'echo " FAIL  src/a.test.ts > a > one"; echo " Tests  1 failed | 1 passed (2)"; exit 1'
    );
    const { result } = runStep();
    assert.equal(result.action, 'failed');
    assert.equal(callCount(), 1);
  });
});

describe('4_run_tests — baseline delta (echo-5137-4)', () => {
  it('without a baseline the report says baseline unavailable', () => {
    process.env.CHECK_FLAKE_RETRY = '0';
    process.env.SCRIPT_RUN_AFFECTED_UNIT = makeScript(
      'fail2.sh',
      'echo " FAIL  src/a.test.ts > a > one"; echo " Tests  1 failed | 1 passed (2)"; exit 1'
    );
    const { report } = runStep();
    assert.match(report, /Baseline unavailable/);
  });

  it('with a cached baseline, failures split into net-new vs pre-existing', () => {
    process.env.CHECK_FLAKE_RETRY = '0';
    fs.writeFileSync(
      path.join(dir, BASELINE_FILE),
      JSON.stringify({
        ref: 'base123',
        recordedAt: '2026-07-01T00:00:00Z',
        failures: ['src/old.test.ts > legacy > known flake'],
      })
    );
    process.env.SCRIPT_RUN_AFFECTED_UNIT = makeScript(
      'delta.sh',
      [
        'echo " FAIL  src/old.test.ts > legacy > known flake"',
        'echo " FAIL  src/new.test.ts > feature > fresh regression"',
        'echo " Tests  2 failed | 10 passed (12)"',
        'exit 1',
      ].join('\n')
    );
    const { result, report } = runStep();
    assert.equal(result.action, 'failed');
    assert.match(report, /### Net-new failures \(1\)/);
    assert.match(report, /src\/new\.test\.ts > feature > fresh regression/);
    assert.match(report, /### Pre-existing failures \(1\)/);
    assert.match(report, /src\/old\.test\.ts > legacy > known flake/);
    assert.match(result.reason, /1 net-new .* 1 pre-existing/);
  });
});

describe('4_run_tests — baseline location (PR #669 review)', () => {
  it('writes tests-baseline.json into the ticket tasks dir, NOT the cwd/app worktree', () => {
    const tasksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-tasksdir-'));
    try {
      process.env.SCRIPT_RUN_AFFECTED_UNIT = makeScript(
        'pass2.sh',
        'echo " Tests  5 passed (5)"; exit 0'
      );
      const state = { setupResult: { reportFolder: dir }, changesHash: 'abc123', ticketId: 'T-1' };
      const result = handler(state, { tasksDir, checkHooksDir: dir });
      assert.equal(result, null);
      assert.ok(
        fs.existsSync(path.join(tasksDir, BASELINE_FILE)),
        'baseline must live in the tasks dir (same place the check state lives)'
      );
      assert.equal(
        fs.existsSync(path.join(dir, BASELINE_FILE)),
        false,
        'baseline must NOT pollute the app worktree root (cwd)'
      );
    } finally {
      fs.rmSync(tasksDir, { recursive: true, force: true });
    }
  });

  it('reads the cached baseline from the tasks dir for the net-new split', () => {
    const tasksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-tasksdir2-'));
    try {
      process.env.CHECK_FLAKE_RETRY = '0';
      fs.writeFileSync(
        path.join(tasksDir, BASELINE_FILE),
        JSON.stringify({ ref: 'base123', recordedAt: 'x', failures: ['src/old.test.ts > known'] })
      );
      process.env.SCRIPT_RUN_AFFECTED_UNIT = makeScript(
        'fail3.sh',
        'echo " FAIL  src/old.test.ts > known"; echo " Tests  1 failed | 1 passed (2)"; exit 1'
      );
      const state = { setupResult: { reportFolder: dir }, changesHash: 'abc123', ticketId: 'T-1' };
      const result = handler(state, { tasksDir, checkHooksDir: dir });
      assert.equal(result.action, 'failed');
      const report = fs.readFileSync(path.join(dir, 'tests.check.md'), 'utf8');
      assert.match(report, /### Pre-existing failures \(1\)/);
    } finally {
      fs.rmSync(tasksDir, { recursive: true, force: true });
    }
  });
});
