/**
 * RC-D regression tests for the empty-command trap.
 *
 * Symptom: an unbound test-command env var expanded inside `eval "$VAR"`
 * becomes `eval ""` and exits 0 silently. The original guard only checked
 * the exit code, so it recorded false-positive GREEN evidence. The task
 * advanced and the next task's scope hook then blocked edits to the
 * still-unwritten source — agents could not recover via /work (observed
 * on GH-417 / 432 / 452).
 *
 * Defense: refuse to record GREEN or REFACTOR when the command exits 0 AND
 * produced empty stdout AND empty stderr. Real test runners always emit
 * something (a summary line, a progress dot, anything).
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLI_PATH = path.join(__dirname, '..', 'tdd-phase-state.js');

function mkTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-empty-cmd-'));
  fs.mkdirSync(path.join(dir, 'worktrees', 'tasks'), { recursive: true });
  return dir;
}

function runCli(args, homeDir) {
  try {
    const stdout = execSync(`node ${CLI_PATH} ${args}`, {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDir,
        TASKS_BASE: path.join(homeDir, 'worktrees', 'tasks'),
        WORK_TDD_TOKEN_SKIP: '1',
        WORK_TDD_SKIP_WORKSPACE_CHECK: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e) {
    return {
      stdout: e.stdout || '',
      stderr: e.stderr || e.message,
      exitCode: typeof e.status === 'number' ? e.status : 1,
    };
  }
}

function seedPhase(homeDir, ticket, phase) {
  runCli(`init ${ticket}`, homeDir);
  const statePath = path.join(homeDir, 'worktrees', 'tasks', ticket, 'tdd-phase.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.currentPhase = phase;
  state.cycles = [
    {
      cycle: 1,
      red: {
        testFiles: ['x.test.ts'],
        testCommand: 'false',
        testExitCode: 1,
        timestamp: new Date().toISOString(),
      },
    },
  ];
  if (phase === 'refactor') {
    state.cycles[0].green = {
      testCommand: "echo 'real output'",
      testExitCode: 0,
      timestamp: new Date().toISOString(),
    };
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

describe('RC-D — empty-command trap', () => {
  let homeDir;
  beforeEach(() => { homeDir = mkTempHome(); });
  afterEach(() => { fs.rmSync(homeDir, { recursive: true, force: true }); });

  it('GREEN: refuses to record when eval-of-empty-string exits 0', () => {
    seedPhase(homeDir, 'TEST-1', 'green');
    const r = runCli('record-green TEST-1 --cmd \'eval ""\'', homeDir);
    assert.notStrictEqual(r.exitCode, 0);
    assert.match(r.stderr, /empty-command trap|NO stdout\/stderr/i);
  });

  it('GREEN: catches unbound test-command env var pattern', () => {
    seedPhase(homeDir, 'TEST-2', 'green');
    // Simulate the real wedge: env var is unset, expanded inside eval.
    const r = runCli('record-green TEST-2 --cmd \'eval "$TEST_UNIT_COMMAND_UNSET"\'', homeDir);
    assert.notStrictEqual(r.exitCode, 0);
    assert.match(r.stderr, /empty-command trap|NO stdout\/stderr/i);
  });

  it('GREEN: accepts command that prints to stdout (real test runner)', () => {
    seedPhase(homeDir, 'TEST-3', 'green');
    const sh = path.join(homeDir, 'pass-stdout.sh');
    fs.writeFileSync(sh, "#!/bin/sh\necho '1 passed'\nexit 0\n", { mode: 0o755 });
    const r = runCli(`record-green TEST-3 --cmd "${sh}"`, homeDir);
    assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
  });

  it('GREEN: accepts command that prints only to stderr', () => {
    seedPhase(homeDir, 'TEST-4', 'green');
    const sh = path.join(homeDir, 'pass-stderr.sh');
    fs.writeFileSync(sh, "#!/bin/sh\necho '1 passed' >&2\nexit 0\n", { mode: 0o755 });
    const r = runCli(`record-green TEST-4 --cmd "${sh}"`, homeDir);
    assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
  });

  it('REFACTOR: same empty-command guard fires', () => {
    seedPhase(homeDir, 'TEST-5', 'refactor');
    const r = runCli('record-refactor TEST-5 --cmd \'eval ""\'', homeDir);
    assert.notStrictEqual(r.exitCode, 0);
    assert.match(r.stderr, /empty-command trap|NO stdout\/stderr/i);
  });
});
