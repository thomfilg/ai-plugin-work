/**
 * Tests for check2/lib/run-affected-suite.js (GH-394): crash-vs-fail
 * classification in the shared suite step, the canonical `**Status:**` line,
 * and the e2e Spec Scoping report section (echo-5224).
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAffectedSuite } = require('../lib/run-affected-suite');

const ENV_VAR = 'TEST_AFFECTED_SUITE_CMD';

let dir;
let originalCwd;

beforeEach(() => {
  originalCwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-affected-suite-'));
  process.chdir(dir); // not a git repo → base ref unresolvable → unscoped fallback
  delete process.env.CHECK_E2E_SPEC_TIMEOUT_MS;
});

afterEach(() => {
  process.chdir(originalCwd);
  delete process.env[ENV_VAR];
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeScript(name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return `bash "${p}"`;
}

function runSuite(opts = {}) {
  const step = runAffectedSuite({
    envVar: ENV_VAR,
    stepName: '9_run_e2e',
    reportFile: 'e2e-tests.check.md',
    label: 'E2E',
    timeout: 60000,
    ...opts,
  });
  const state = { setupResult: { reportFolder: dir }, ticketId: 'T-1' };
  const result = step(state, { tasksDir: dir });
  let report = null;
  try {
    report = fs.readFileSync(path.join(dir, 'e2e-tests.check.md'), 'utf8');
  } catch {
    /* skipped step writes no report */
  }
  return { result, report, state };
}

describe('runAffectedSuite', () => {
  it('skips silently when the env var is not configured', () => {
    const { result, report } = runSuite();
    assert.equal(result, null);
    assert.equal(report, null);
  });

  it('green run → APPROVED with canonical **Status:** line', () => {
    process.env[ENV_VAR] = makeScript('pass.sh', 'echo " Tests  3 passed (3)"; exit 0');
    const { result, report } = runSuite();
    assert.equal(result, null);
    assert.match(report, /\*\*Status:\*\* APPROVED/);
    assert.match(report, /\*\*Result:\*\* PASSED/);
  });

  it('assertion failure → FAILED with failing count in the reason', () => {
    process.env[ENV_VAR] = makeScript(
      'fail.sh',
      'echo " FAIL  tests/e2e/specs/a.spec.ts > a > one"; echo " Tests  1 failed | 2 passed (3)"; exit 1'
    );
    const { result, report } = runSuite();
    assert.equal(result.action, 'failed');
    assert.match(result.reason, /E2E tests failed \(1 failing\)/);
    assert.match(report, /\*\*Result:\*\* FAILED/);
  });

  it('runner crash → CRASHED with quoted signature, never "tests failed"', () => {
    process.env[ENV_VAR] = makeScript(
      'crash.sh',
      'echo " Tests  10 passed (10)"; echo "FATAL ERROR: JavaScript heap out of memory"; exit 134'
    );
    const { result, report } = runSuite();
    assert.equal(result.action, 'failed');
    assert.match(result.reason, /CRASHED/);
    assert.match(result.reason, /JavaScript heap out of memory/);
    assert.match(report, /\*\*Result:\*\* CRASHED/);
    assert.match(report, /## Crash Signature/);
  });

  it('scopeSpecs: reports unscoped fallback when no base ref is resolvable', () => {
    process.env[ENV_VAR] = makeScript('pass.sh', 'echo " Tests  3 passed (3)"; exit 0');
    const { report } = runSuite({ scopeSpecs: true });
    assert.match(report, /## Spec Scoping/);
    assert.match(report, /Base ref unresolvable — CHANGED_SPECS not exported/);
  });

  it('scopeSpecs: the suite command receives E2E_PER_SPEC_TIMEOUT_MS', () => {
    process.env[ENV_VAR] = makeScript(
      'env.sh',
      'echo "budget=$E2E_PER_SPEC_TIMEOUT_MS"; echo " Tests  1 passed (1)"; exit 0'
    );
    const { report } = runSuite({ scopeSpecs: true });
    assert.match(report, /budget=60000/);
  });
});
