/**
 * Step-level tests for the typecheck delta in check 4_run_tests
 * (GH-394, echo-5137-issue-4): net-new typecheck errors block a green test
 * run, pre-existing errors are informational, unconfigured/toggled-off/unsafe
 * commands skip silently.
 *
 * Drives the real step handler through tier-0 (SCRIPT_RUN_AFFECTED_UNIT)
 * fixture scripts, with SCRIPT_TYPECHECK_COMMAND pointing at fixture scripts
 * emitting tsc-like output.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registerRunTests = require('../lib/steps/run-tests');
const { TYPECHECK_BASELINE_FILE } = require('../lib/typecheck-baseline');

let handler;
registerRunTests((name, fn) => {
  assert.equal(name, '4_run_tests');
  handler = fn;
});

const ENV_KEYS = [
  'SCRIPT_RUN_AFFECTED_UNIT',
  'SCRIPT_RUN_AFFECTED_INTEGRATION',
  'SCRIPT_RUN_AFFECTED_E2E',
  'SCRIPT_TYPECHECK_COMMAND',
  'CHECK_TYPECHECK_BASELINE',
  'CHECK_FLAKE_RETRY',
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-typecheck-'));
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
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return `bash "${p}"`;
}

function greenUnitSuite() {
  process.env.SCRIPT_RUN_AFFECTED_UNIT = makeScript(
    'pass.sh',
    'echo " Tests  5 passed (5)"; exit 0'
  );
}

function typecheckScript(lines, exitCode) {
  return makeScript(
    'typecheck.sh',
    [...lines.map((l) => `echo "${l}"`), `exit ${exitCode}`].join('\n')
  );
}

function runStep() {
  const state = { setupResult: { reportFolder: dir }, changesHash: 'abc123', ticketId: 'T-1' };
  const ctx = { tasksDir: dir, checkHooksDir: dir };
  const result = handler(state, ctx);
  const report = fs.readFileSync(path.join(dir, 'tests.check.md'), 'utf8');
  return { result, report, state };
}

function seedBaseline(errors) {
  fs.writeFileSync(
    path.join(dir, TYPECHECK_BASELINE_FILE),
    JSON.stringify({ ref: 'base123', recordedAt: '2026-07-01T00:00:00Z', errors })
  );
}

describe('4_run_tests — typecheck delta (echo-5137-issue-4)', () => {
  it('unconfigured → no Typecheck Delta section, green run passes (silent skip)', () => {
    greenUnitSuite();
    const { result, report } = runStep();
    assert.equal(result, null);
    assert.doesNotMatch(report, /Typecheck Delta/);
  });

  it('CHECK_TYPECHECK_BASELINE=0 disables the delta even when configured', () => {
    greenUnitSuite();
    process.env.CHECK_TYPECHECK_BASELINE = '0';
    process.env.SCRIPT_TYPECHECK_COMMAND = typecheckScript(
      ['src/new.ts(1,1): error TS2322: Wrong type'],
      2
    );
    const { result, report } = runStep();
    assert.equal(result, null);
    assert.doesNotMatch(report, /Typecheck Delta/);
  });

  it('unsafe SCRIPT_TYPECHECK_COMMAND is rejected (never executed), step unaffected', () => {
    greenUnitSuite();
    process.env.SCRIPT_TYPECHECK_COMMAND = `bash evil.sh; touch "${dir}/pwned"`;
    const { result, report } = runStep();
    assert.equal(result, null);
    assert.doesNotMatch(report, /Typecheck Delta/);
    assert.equal(fs.existsSync(path.join(dir, 'pwned')), false, 'unsafe command never ran');
  });

  it('first run captures the baseline: green tests + inherited errors still pass', () => {
    greenUnitSuite();
    process.env.SCRIPT_TYPECHECK_COMMAND = typecheckScript(
      ['src/old.ts(3,1): error TS2345: Bad arg'],
      2
    );
    const { result, report } = runStep();
    assert.equal(result, null, 'first run never blocks on typecheck');
    assert.match(report, /\*\*Status:\*\* APPROVED/);
    assert.match(report, /## Typecheck Delta/);
    assert.match(report, /Baseline captured on this run/);
    assert.ok(fs.existsSync(path.join(dir, TYPECHECK_BASELINE_FILE)));
  });

  it('net-new typecheck error → NEEDS_WORK with the per-key list, even though tests pass', () => {
    greenUnitSuite();
    seedBaseline(['src/old.ts [TS2345] Bad arg']);
    process.env.SCRIPT_TYPECHECK_COMMAND = typecheckScript(
      ['src/old.ts(3,1): error TS2345: Bad arg', 'src/new.ts(9,2): error TS2322: Wrong type'],
      2
    );
    const { result, report, state } = runStep();
    assert.ok(result, 'blocks');
    assert.equal(result.action, 'failed');
    assert.equal(state.testsFailed, true);
    assert.match(result.reason, /Typecheck regressed: 1 net-new error\(s\)/);
    assert.match(result.reason, /src\/new\.ts \[TS2322\] Wrong type/);
    assert.match(result.reason, /1 pre-existing, not yours/);
    assert.match(report, /\*\*Status:\*\* NEEDS_WORK/);
    assert.match(
      report,
      /\*\*Errors at baseline:\*\* 1 \| \*\*errors now:\*\* 2 \| \*\*net new from your changes:\*\* 1/
    );
    assert.match(report, /### Net-new typecheck errors \(1\)/);
    assert.match(report, /BUT typecheck regressed \(1 net-new error\(s\)/);
  });

  it('pre-existing errors only → pass with the informational "not yours" line', () => {
    greenUnitSuite();
    seedBaseline(['src/old.ts [TS2345] Bad arg']);
    process.env.SCRIPT_TYPECHECK_COMMAND = typecheckScript(
      ['src/old.ts(3,1): error TS2345: Bad arg'],
      2
    );
    const { result, report } = runStep();
    assert.equal(result, null, 'pre-existing errors never block');
    assert.match(report, /\*\*Status:\*\* APPROVED/);
    assert.match(report, /1 pre-existing error\(s\) \(not yours\) — not blocking\./);
  });

  it('same baseline error at a drifted line → still passes (line-drift immunity)', () => {
    greenUnitSuite();
    seedBaseline(['src/old.ts [TS2345] Bad arg']);
    process.env.SCRIPT_TYPECHECK_COMMAND = typecheckScript(
      ['src/old.ts(88,4): error TS2345: Bad arg'],
      2
    );
    const { result } = runStep();
    assert.equal(result, null);
  });

  it('failing tests take reason precedence; report still carries the typecheck section', () => {
    process.env.CHECK_FLAKE_RETRY = '0';
    process.env.SCRIPT_RUN_AFFECTED_UNIT = makeScript(
      'fail.sh',
      'echo " FAIL  src/a.test.ts > a > one"; echo " Tests  1 failed | 1 passed (2)"; exit 1'
    );
    seedBaseline([]);
    process.env.SCRIPT_TYPECHECK_COMMAND = typecheckScript(
      ['src/new.ts(9,2): error TS2322: Wrong type'],
      2
    );
    const { result, report } = runStep();
    assert.equal(result.action, 'failed');
    assert.match(result.reason, /Tests failed/);
    assert.match(report, /## Typecheck Delta/);
    assert.match(report, /### Net-new typecheck errors \(1\)/);
  });
});
