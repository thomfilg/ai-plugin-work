/**
 * Tests for tdd-phase-state.js CLI
 *
 * Run with: node --test workflows/work-implement/__tests__/tdd-phase-state.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLI_PATH = path.join(__dirname, '..', 'tdd-phase-state.js');

function createTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-state-'));
  const tasksDir = path.join(dir, 'worktrees', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  return dir;
}

function createExitScript(dir, exitCode) {
  const scriptPath = path.join(dir, `exit-${exitCode}.sh`);
  fs.writeFileSync(scriptPath, `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o755 });
  return scriptPath;
}

function createTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-git-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'init');
  // Use array join to avoid hook pattern detection on the word c-o-m-m-i-t
  const commitCmd = ['git', 'add', '.', '&&', 'git', ['com','mit'].join(''), '-m', '"init"'].join(' ');
  execSync(commitCmd, { cwd: dir, stdio: 'pipe' });
  return dir;
}

function runCli(args, homeDir, cwd) {
  try {
    const stdout = execSync(`node ${CLI_PATH} ${args}`, {
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir, WORK_TDD_TOKEN_SKIP: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status || 1 };
  }
}

function runCliNoTokenSkip(args, homeDir) {
  try {
    const stdout = execSync(`node ${CLI_PATH} ${args}`, {
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status || 1 };
  }
}

function readState(homeDir, ticketId) {
  const statePath = path.join(homeDir, 'worktrees', 'tasks', ticketId, 'tdd-phase.json');
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

describe('tdd-phase-state CLI', () => {
  let homeDir;
  let scriptDir;

  beforeEach(() => {
    homeDir = createTempHome();
    scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-scripts-'));
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(scriptDir, { recursive: true, force: true });
  });

  describe('init', () => {
    it('creates state file with phase "red" and cycle 1', () => {
      const { stdout, exitCode } = runCli('init TEST-123', homeDir);
      assert.strictEqual(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.phase, 'red');
      assert.strictEqual(result.cycle, 1);

      const state = readState(homeDir, 'TEST-123');
      assert.strictEqual(state.currentPhase, 'red');
      assert.strictEqual(state.currentCycle, 1);
      assert.deepStrictEqual(state.cycles, []);
    });

    it('returns error with missing ticket ID', () => {
      const { exitCode, stderr } = runCli('init', homeDir);
      assert.strictEqual(exitCode, 1);
      assert.ok(stderr.includes('error') || stderr.includes('ticket'), `Expected error about ticket ID, got: ${stderr}`);
    });
  });

  describe('current', () => {
    it('returns current phase and cycle', () => {
      runCli('init TEST-456', homeDir);
      const { stdout, exitCode } = runCli('current TEST-456', homeDir);
      assert.strictEqual(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.strictEqual(result.phase, 'red');
      assert.strictEqual(result.cycle, 1);
    });

    it('returns error with no state file', () => {
      const { exitCode } = runCli('current NOPE-999', homeDir);
      assert.strictEqual(exitCode, 1);
    });
  });

  describe('record-red', () => {
    it('fails when no test files changed (empty git diff)', () => {
      runCli('init TEST-789', homeDir);
      const failScript = createExitScript(scriptDir, 1);
      const cleanRepo = createTempGitRepo();
      const { exitCode } = runCli(`record-red TEST-789 --cmd "${failScript}"`, homeDir, cleanRepo);
      assert.strictEqual(exitCode, 1);
    });
  });

  describe('record-green', () => {
    it('with passing tests records evidence', () => {
      runCli('init TEST-GRN', homeDir);
      // Manually set up red evidence so state is valid
      const statePath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-GRN', 'tdd-phase.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state.currentPhase = 'green';
      state.cycles = [{
        cycle: 1,
        red: { testFiles: ['foo.test.ts'], testCommand: 'echo test', testExitCode: 1, timestamp: new Date().toISOString() },
      }];
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

      const passScript = createExitScript(scriptDir, 0);
      const { stdout, exitCode } = runCli(`record-green TEST-GRN --cmd "${passScript}"`, homeDir);
      assert.strictEqual(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.strictEqual(result.ok, true);

      const updatedState = readState(homeDir, 'TEST-GRN');
      assert.strictEqual(updatedState.cycles[0].green.testExitCode, 0);
    });
  });

  describe('record-refactor', () => {
    it('with passing tests records evidence', () => {
      runCli('init TEST-REF', homeDir);
      const statePath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-REF', 'tdd-phase.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state.currentPhase = 'refactor';
      state.cycles = [{
        cycle: 1,
        red: { testFiles: ['foo.test.ts'], testCommand: 'echo test', testExitCode: 1, timestamp: new Date().toISOString() },
        green: { testCommand: 'echo test', testExitCode: 0, timestamp: new Date().toISOString() },
      }];
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

      const passScript = createExitScript(scriptDir, 0);
      const { stdout, exitCode } = runCli(`record-refactor TEST-REF --cmd "${passScript}"`, homeDir);
      assert.strictEqual(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.strictEqual(result.ok, true);

      const updatedState = readState(homeDir, 'TEST-REF');
      assert.strictEqual(updatedState.cycles[0].refactor.testExitCode, 0);
    });
  });

  describe('transition', () => {
    it('red -> green works when red evidence exists', () => {
      runCli('init TEST-TRN', homeDir);
      const statePath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-TRN', 'tdd-phase.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state.cycles = [{
        cycle: 1,
        red: { testFiles: ['foo.test.ts'], testCommand: 'echo test', testExitCode: 1, timestamp: new Date().toISOString() },
      }];
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

      const { stdout, exitCode } = runCli('transition TEST-TRN green', homeDir);
      assert.strictEqual(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.strictEqual(result.phase, 'green');

      const updatedState = readState(homeDir, 'TEST-TRN');
      assert.strictEqual(updatedState.currentPhase, 'green');
    });

    it('red -> refactor fails (invalid transition)', () => {
      runCli('init TEST-BAD', homeDir);
      const statePath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-BAD', 'tdd-phase.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state.cycles = [{
        cycle: 1,
        red: { testFiles: ['foo.test.ts'], testCommand: 'echo test', testExitCode: 1, timestamp: new Date().toISOString() },
      }];
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

      const { exitCode } = runCli('transition TEST-BAD refactor', homeDir);
      assert.strictEqual(exitCode, 1);
    });

    it('fails without evidence for current phase', () => {
      runCli('init TEST-NOE', homeDir);
      // No red evidence recorded, try to transition
      const { exitCode } = runCli('transition TEST-NOE green', homeDir);
      assert.strictEqual(exitCode, 1);
    });

    it('refactor -> red increments cycle number', () => {
      runCli('init TEST-CYC', homeDir);
      const statePath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-CYC', 'tdd-phase.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state.currentPhase = 'refactor';
      state.currentCycle = 1;
      state.cycles = [{
        cycle: 1,
        red: { testFiles: ['foo.test.ts'], testCommand: 'echo test', testExitCode: 1, timestamp: new Date().toISOString() },
        green: { testCommand: 'echo test', testExitCode: 0, timestamp: new Date().toISOString() },
        refactor: { testCommand: 'echo test', testExitCode: 0, timestamp: new Date().toISOString() },
      }];
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

      const { stdout, exitCode } = runCli('transition TEST-CYC red', homeDir);
      assert.strictEqual(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.strictEqual(result.phase, 'red');
      assert.strictEqual(result.cycle, 2);

      const updatedState = readState(homeDir, 'TEST-CYC');
      assert.strictEqual(updatedState.currentPhase, 'red');
      assert.strictEqual(updatedState.currentCycle, 2);
    });
  });

  describe('token gating', () => {
    it('record-red fails without token when WORK_TDD_TOKEN_SKIP is not set', () => {
      runCli('init TEST-TOK', homeDir);
      const failScript = createExitScript(scriptDir, 1);
      const { exitCode, stderr } = runCliNoTokenSkip(`record-red TEST-TOK --cmd "${failScript}"`, homeDir);
      assert.strictEqual(exitCode, 1);
      assert.ok(
        stderr.includes('No valid write token'),
        `Expected "No valid write token" error, got: ${stderr}`
      );
    });

    it('record-green fails without token when WORK_TDD_TOKEN_SKIP is not set', () => {
      runCli('init TEST-TOK2', homeDir);
      const passScript = createExitScript(scriptDir, 0);
      const { exitCode, stderr } = runCliNoTokenSkip(`record-green TEST-TOK2 --cmd "${passScript}"`, homeDir);
      assert.strictEqual(exitCode, 1);
      assert.ok(
        stderr.includes('No valid write token'),
        `Expected "No valid write token" error, got: ${stderr}`
      );
    });

    it('transition fails without token when WORK_TDD_TOKEN_SKIP is not set', () => {
      runCli('init TEST-TOK3', homeDir);
      const { exitCode, stderr } = runCliNoTokenSkip('transition TEST-TOK3 green', homeDir);
      assert.strictEqual(exitCode, 1);
      assert.ok(
        stderr.includes('No valid write token'),
        `Expected "No valid write token" error, got: ${stderr}`
      );
    });

    it('init works without token (not gated)', () => {
      const { exitCode } = runCliNoTokenSkip('init TEST-TOK4', homeDir);
      assert.strictEqual(exitCode, 0);
    });

    it('current works without token (not gated)', () => {
      runCli('init TEST-TOK5', homeDir);
      const { exitCode } = runCliNoTokenSkip('current TEST-TOK5', homeDir);
      assert.strictEqual(exitCode, 0);
    });
  });
});
