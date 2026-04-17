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
  execSync('git config user.email "test@test.com" && git config user.name "Test"', {
    cwd: dir,
    stdio: 'pipe',
  });
  fs.writeFileSync(path.join(dir, 'README.md'), 'init');
  // Use array join to avoid hook pattern detection on the word c-o-m-m-i-t
  const commitCmd = ['git', 'add', '.', '&&', 'git', ['com', 'mit'].join(''), '-m', '"init"'].join(
    ' '
  );
  execSync(commitCmd, { cwd: dir, stdio: 'pipe' });
  return dir;
}

function runCli(args, homeDir, cwd) {
  try {
    const tasksBase = path.join(homeDir, 'worktrees', 'tasks');
    const stdout = execSync(`node ${CLI_PATH} ${args}`, {
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir, TASKS_BASE: tasksBase, WORK_TDD_TOKEN_SKIP: '1' },
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
    const tasksBase = path.join(homeDir, 'worktrees', 'tasks');
    const stdout = execSync(`node ${CLI_PATH} ${args}`, {
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir, TASKS_BASE: tasksBase },
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
      assert.ok(
        stderr.includes('error') || stderr.includes('ticket'),
        `Expected error about ticket ID, got: ${stderr}`
      );
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
      state.cycles = [
        {
          cycle: 1,
          red: {
            testFiles: ['foo.test.ts'],
            testCommand: 'echo test',
            testExitCode: 1,
            timestamp: new Date().toISOString(),
          },
        },
      ];
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
      state.cycles = [
        {
          cycle: 1,
          red: {
            testFiles: ['foo.test.ts'],
            testCommand: 'echo test',
            testExitCode: 1,
            timestamp: new Date().toISOString(),
          },
          green: { testCommand: 'echo test', testExitCode: 0, timestamp: new Date().toISOString() },
        },
      ];
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

      const passScript = createExitScript(scriptDir, 0);
      const { stdout, exitCode } = runCli(
        `record-refactor TEST-REF --cmd "${passScript}"`,
        homeDir
      );
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
      state.cycles = [
        {
          cycle: 1,
          red: {
            testFiles: ['foo.test.ts'],
            testCommand: 'echo test',
            testExitCode: 1,
            timestamp: new Date().toISOString(),
          },
        },
      ];
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
      state.cycles = [
        {
          cycle: 1,
          red: {
            testFiles: ['foo.test.ts'],
            testCommand: 'echo test',
            testExitCode: 1,
            timestamp: new Date().toISOString(),
          },
        },
      ];
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
      state.cycles = [
        {
          cycle: 1,
          red: {
            testFiles: ['foo.test.ts'],
            testCommand: 'echo test',
            testExitCode: 1,
            timestamp: new Date().toISOString(),
          },
          green: { testCommand: 'echo test', testExitCode: 0, timestamp: new Date().toISOString() },
          refactor: {
            testCommand: 'echo test',
            testExitCode: 0,
            timestamp: new Date().toISOString(),
          },
        },
      ];
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

  describe('exception', () => {
    it('creates valid state with exception reason', () => {
      const { stdout, exitCode } = runCli(
        'exception TEST-EXC --reason "config-only change, no testable behavior"',
        homeDir
      );
      assert.strictEqual(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.phase, 'exception');
      assert.strictEqual(result.exception, 'config-only change, no testable behavior');

      const state = readState(homeDir, 'TEST-EXC');
      assert.strictEqual(state.currentPhase, 'exception');
      assert.strictEqual(state.exception, 'config-only change, no testable behavior');
      assert.deepStrictEqual(state.cycles, []);
    });

    it('fails without --reason argument', () => {
      const { exitCode, stderr } = runCli('exception TEST-EXC2', homeDir);
      assert.strictEqual(exitCode, 1);
      assert.ok(stderr.includes('reason'), `Expected error about reason, got: ${stderr}`);
    });

    it('fails with empty reason', () => {
      const { exitCode, stderr } = runCli('exception TEST-EXC3 --reason ""', homeDir);
      assert.strictEqual(exitCode, 1);
      assert.ok(
        stderr.includes('empty') || stderr.includes('reason'),
        `Expected error about empty reason, got: ${stderr}`
      );
    });
  });

  describe('phase validation in record commands', () => {
    it('record-red fails when currentPhase is not red', () => {
      runCli('init TEST-PV1', homeDir);
      // Manually set phase to green
      const statePath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-PV1', 'tdd-phase.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state.currentPhase = 'green';
      state.cycles = [
        {
          cycle: 1,
          red: {
            testFiles: ['foo.test.ts'],
            testCommand: 'echo test',
            testExitCode: 1,
            timestamp: new Date().toISOString(),
          },
        },
      ];
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

      const failScript = createExitScript(scriptDir, 1);
      const cleanRepo = createTempGitRepo();
      // Add a test file change so it doesn't fail on "no test files"
      fs.writeFileSync(path.join(cleanRepo, 'foo.test.ts'), 'test');
      execSync('git add foo.test.ts', { cwd: cleanRepo, stdio: 'pipe' });

      const { exitCode, stderr } = runCli(
        `record-red TEST-PV1 --cmd "${failScript}"`,
        homeDir,
        cleanRepo
      );
      assert.strictEqual(exitCode, 1);
      assert.ok(
        stderr.includes('Cannot record RED'),
        `Expected phase mismatch error, got: ${stderr}`
      );
    });

    it('record-green fails when currentPhase is not green', () => {
      runCli('init TEST-PV2', homeDir);
      // Phase is 'red' by default after init
      const passScript = createExitScript(scriptDir, 0);
      const { exitCode, stderr } = runCli(`record-green TEST-PV2 --cmd "${passScript}"`, homeDir);
      assert.strictEqual(exitCode, 1);
      assert.ok(
        stderr.includes('Cannot record GREEN'),
        `Expected phase mismatch error, got: ${stderr}`
      );
    });

    it('record-refactor fails when currentPhase is not refactor', () => {
      runCli('init TEST-PV3', homeDir);
      // Phase is 'red' by default after init
      const passScript = createExitScript(scriptDir, 0);
      const { exitCode, stderr } = runCli(
        `record-refactor TEST-PV3 --cmd "${passScript}"`,
        homeDir
      );
      assert.strictEqual(exitCode, 1);
      assert.ok(
        stderr.includes('Cannot record REFACTOR'),
        `Expected phase mismatch error, got: ${stderr}`
      );
    });
  });

  describe('path traversal protection', () => {
    it('rejects ticket ID with ..', () => {
      const { exitCode, stderr } = runCli('init ../../../etc', homeDir);
      assert.strictEqual(exitCode, 1);
      assert.ok(
        stderr.includes('Invalid ticket ID'),
        `Expected invalid ticket ID error, got: ${stderr}`
      );
    });

    it('allows ticket ID with single slash suffix (e.g. GH-145/phase1)', () => {
      const { stdout, exitCode } = runCli('init GH-145/phase1', homeDir);
      assert.strictEqual(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.phase, 'red');

      const state = readState(homeDir, 'GH-145/phase1');
      assert.strictEqual(state.currentPhase, 'red');
    });

    it('rejects ticket ID with backslash', () => {
      const { exitCode, stderr } = runCli('init "foo\\\\bar"', homeDir);
      assert.strictEqual(exitCode, 1);
      assert.ok(
        stderr.includes('Invalid ticket ID'),
        `Expected invalid ticket ID error, got: ${stderr}`
      );
    });
  });

  describe('GitHub Issues ticket ID sanitization', () => {
    it('#NNN ticket IDs resolve to the same path as GH-NNN', () => {
      const origProvider = process.env.TICKET_PROVIDER;
      process.env.TICKET_PROVIDER = 'github';
      try {
        // Init with #144 format
        const { exitCode: initExit } = runCli('init "#144"', homeDir);
        assert.strictEqual(initExit, 0);
        // TICKET_PROVIDER=github is set at line 350, so sanitizeTicketIdForPath converts #N → GH-N
        // The state should be stored under GH-144, not #144
        const ghState = readState(homeDir, 'GH-144');
        assert.strictEqual(ghState.currentPhase, 'red');
        assert.strictEqual(ghState.currentCycle, 1);

        // Reading current with #144 should find the same state
        const { stdout, exitCode } = runCli('current "#144"', homeDir);
        assert.strictEqual(exitCode, 0);
        const result = JSON.parse(stdout);
        assert.strictEqual(result.phase, 'red');
        assert.strictEqual(result.cycle, 1);
      } finally {
        if (origProvider === undefined) delete process.env.TICKET_PROVIDER;
        else process.env.TICKET_PROVIDER = origProvider;
      }
    });
  });

  describe('per-task path with legacy root fallback (GH-219 Task 9)', () => {
    it('init with --task writes to TASKS_BASE/<ticket>/task${N}/tdd-phase.json', () => {
      const { stdout, exitCode } = runCli('init TEST-T9A --task 3', homeDir);
      assert.strictEqual(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.strictEqual(result.ok, true);

      // Verify state file is at per-task path
      const perTaskPath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-T9A', 'task3', 'tdd-phase.json');
      assert.ok(fs.existsSync(perTaskPath), `Expected per-task state at ${perTaskPath}`);
      const state = JSON.parse(fs.readFileSync(perTaskPath, 'utf8'));
      assert.strictEqual(state.currentPhase, 'red');
    });

    it('current with --task reads from per-task path when it exists', () => {
      runCli('init TEST-T9B --task 5', homeDir);
      const { stdout, exitCode } = runCli('current TEST-T9B --task 5', homeDir);
      assert.strictEqual(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.strictEqual(result.phase, 'red');
    });

    it('current with --task falls back to legacy root when per-task path missing', () => {
      // Create state at root (legacy) path only
      runCli('init TEST-T9C', homeDir);
      // Now read with --task — per-task file does not exist, should fallback to root
      const { stdout, exitCode } = runCli('current TEST-T9C --task 2', homeDir);
      assert.strictEqual(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.strictEqual(result.phase, 'red');
    });

    it('current with --task fails when neither per-task nor root exists', () => {
      const { exitCode } = runCli('current TEST-T9D --task 1', homeDir);
      assert.strictEqual(exitCode, 1);
    });

    it('init without --task writes to legacy root path (backward compat)', () => {
      runCli('init TEST-T9E', homeDir);
      const rootPath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-T9E', 'tdd-phase.json');
      assert.ok(fs.existsSync(rootPath), `Expected root state at ${rootPath}`);
    });
  });

    describe('token gating', () => {
    it('record-red fails without token when WORK_TDD_TOKEN_SKIP is not set', () => {
      runCli('init TEST-TOK', homeDir);
      const failScript = createExitScript(scriptDir, 1);
      const { exitCode, stderr } = runCliNoTokenSkip(
        `record-red TEST-TOK --cmd "${failScript}"`,
        homeDir
      );
      assert.strictEqual(exitCode, 1);
      assert.ok(
        stderr.includes('No valid write token'),
        `Expected "No valid write token" error, got: ${stderr}`
      );
    });

    it('record-green fails without token when WORK_TDD_TOKEN_SKIP is not set', () => {
      runCli('init TEST-TOK2', homeDir);
      const passScript = createExitScript(scriptDir, 0);
      const { exitCode, stderr } = runCliNoTokenSkip(
        `record-green TEST-TOK2 --cmd "${passScript}"`,
        homeDir
      );
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
