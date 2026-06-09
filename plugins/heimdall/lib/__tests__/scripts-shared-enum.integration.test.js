// Integration tests for Heimdall scripts/heimdall-scan.js and
// scripts/heimdall-unprotect.js: `shared` kind enum acceptance and help/usage
// text mentions `shared`.
//
// Discovered by plugins/work/scripts/run-tests.sh.
// Manual: node --test plugins/heimdall/lib/__tests__/scripts-shared-enum.integration.test.js
//
// Covers GH-541 Task 7 (R1 portion, spec §API):
//   - heimdall-scan.js --kind=shared exits 0; stderr does NOT contain
//     "unknown kind".
//   - heimdall-unprotect.js --kind=shared (against an empty shared store) does
//     not surface an "unknown kind" enum-validation error.
//   - Each script's usage/help docstring at the top of the file mentions
//     `shared` alongside the other three kinds.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scanScript = path.resolve(__dirname, '..', '..', 'scripts', 'heimdall-scan.js');
const unprotectScript = path.resolve(__dirname, '..', '..', 'scripts', 'heimdall-unprotect.js');
const initScript = path.resolve(__dirname, '..', '..', 'scripts', 'heimdall-init.js');

let originalHome;
let base;
let fakeHome;

before(() => {
  originalHome = os.homedir();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-scripts-shared-it-'));
  fakeHome = path.join(base, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
});

after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(base, { recursive: true, force: true });
});

function run(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, HOME: fakeHome },
    encoding: 'utf8',
  });
}

describe('heimdall-scan.js accepts --kind=shared', () => {
  it('exits 0 and stderr lacks "unknown kind"', () => {
    const cwd = fs.mkdtempSync(path.join(base, 'proj-scan-'));
    const init = run(initScript, ['--kind=shared', `--cwd=${cwd}`], cwd);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);

    const res = run(scanScript, ['--kind=shared', `--cwd=${cwd}`], cwd);
    assert.equal(res.status, 0, `expected exit 0; stderr: ${res.stderr}; stdout: ${res.stdout}`);
    assert.doesNotMatch(
      res.stderr,
      /unknown kind/i,
      `stderr should not contain "unknown kind": ${res.stderr}`
    );
  });

  it('usage docstring mentions "shared"', () => {
    const src = fs.readFileSync(scanScript, 'utf8');
    const headerEnd = src.indexOf('*/');
    assert.notEqual(headerEnd, -1, 'expected a top-of-file docstring');
    const header = src.slice(0, headerEnd);
    assert.match(
      header,
      /shared/,
      `heimdall-scan.js usage docstring should mention "shared": ${header}`
    );
  });
});

describe('heimdall-unprotect.js accepts --kind=shared', () => {
  it('does not surface "unknown kind" enum-validation error', () => {
    const cwd = fs.mkdtempSync(path.join(base, 'proj-unprotect-'));
    const init = run(initScript, ['--kind=shared', `--cwd=${cwd}`], cwd);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);

    // Unprotect against an empty shared store with a phrase that doesn't
    // exist; expected outcome is a "no lock block ... found" message — NOT
    // an enum-validation "unknown kind" error.
    const res = run(
      unprotectScript,
      ['--kind=shared', '--phrase=nonexistent phrase', `--cwd=${cwd}`],
      cwd
    );
    assert.doesNotMatch(
      res.stderr,
      /unknown kind/i,
      `stderr should not contain "unknown kind": ${res.stderr}`
    );
  });

  it('usage docstring mentions "shared"', () => {
    const src = fs.readFileSync(unprotectScript, 'utf8');
    const headerEnd = src.indexOf('*/');
    assert.notEqual(headerEnd, -1, 'expected a top-of-file docstring');
    const header = src.slice(0, headerEnd);
    assert.match(
      header,
      /shared/,
      `heimdall-unprotect.js usage docstring should mention "shared": ${header}`
    );
  });
});
