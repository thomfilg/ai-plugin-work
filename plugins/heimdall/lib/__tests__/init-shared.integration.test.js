// Integration tests for Heimdall scripts/heimdall-init.js --kind=shared support.
//
// Discovered by plugins/work/scripts/run-tests.sh.
// Manual: node --test plugins/heimdall/lib/__tests__/init-shared.integration.test.js
//
// Covers GH-541 Task 3 scenarios (AC4, AC5):
//   - --kind=shared writes marker at exactly ~/.claude/heimdall-shared/.heimdall.json
//     (no <projectName> subdir), with marker kind === "shared".
//   - --kind=bogus exits non-zero; stderr contains local|worktree|global|shared.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const initScript = path.resolve(__dirname, '..', '..', 'scripts', 'heimdall-init.js');
const { FOLDER, MARKER } = require(path.resolve(__dirname, '..', 'lock-store'));

let originalHome;
let base;
let fakeHome;

before(() => {
  originalHome = os.homedir();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-init-shared-it-'));
  fakeHome = path.join(base, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
});

after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(base, { recursive: true, force: true });
});

function runInit(args, cwd) {
  return spawnSync(process.execPath, [initScript, ...args], {
    cwd,
    env: { ...process.env, HOME: fakeHome },
    encoding: 'utf8',
  });
}

describe('heimdall-init.js --kind=shared', () => {
  it('writes marker at ~/.claude/heimdall-shared/.heimdall.json with no project subdir', () => {
    const cwd = fs.mkdtempSync(path.join(base, 'proj-'));
    const res = runInit(['--kind=shared', `--cwd=${cwd}`], cwd);
    assert.equal(res.status, 0, `stderr: ${res.stderr}\nstdout: ${res.stdout}`);

    const expectedDir = path.join(fakeHome, '.claude', `${FOLDER}-shared`);
    const expectedMarker = path.join(expectedDir, MARKER);
    assert.ok(
      fs.existsSync(expectedMarker),
      `expected marker at ${expectedMarker}, got: ${res.stdout}`
    );

    // No project subdir should be created under heimdall-shared.
    const entries = fs.readdirSync(expectedDir);
    assert.deepEqual(
      entries.sort(),
      [MARKER].sort(),
      `expected only the marker in shared dir, got: ${entries.join(', ')}`
    );

    const cfg = JSON.parse(fs.readFileSync(expectedMarker, 'utf8'));
    assert.equal(cfg.kind, 'shared');
    assert.equal(cfg.projectName, null, 'shared marker must not embed a project name');
  });
});

describe('heimdall-init.js --kind=bogus', () => {
  it('exits non-zero and stderr lists local|worktree|global|shared', () => {
    const cwd = fs.mkdtempSync(path.join(base, 'bogus-'));
    const res = runInit(['--kind=bogus', `--cwd=${cwd}`], cwd);
    assert.notEqual(res.status, 0, `expected non-zero exit, got ${res.status}`);
    assert.match(res.stderr, /local\|worktree\|global\|shared/);
    assert.match(res.stderr, /bogus/);
  });
});
