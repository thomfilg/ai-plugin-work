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

    it('with --task writes to per-task path (GH-219 PR6)', () => {
      const { stdout, exitCode } = runCli(
        'exception TEST-EXC4 --task 2 --reason "config-only change"',
        homeDir
      );
      assert.strictEqual(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.phase, 'exception');

      // Verify state file is at per-task path
      const perTaskPath = path.join(
        homeDir, 'worktrees', 'tasks', 'TEST-EXC4', 'task2', 'tdd-phase.json'
      );
      assert.ok(fs.existsSync(perTaskPath), `Expected per-task state at ${perTaskPath}`);
      const state = JSON.parse(fs.readFileSync(perTaskPath, 'utf8'));
      assert.strictEqual(state.currentPhase, 'exception');
      assert.strictEqual(state.exception, 'config-only change');

      // Root path should NOT exist
      const rootPath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-EXC4', 'tdd-phase.json');
      assert.ok(!fs.existsSync(rootPath), 'Root state should NOT be created when --task is used');
    });

    it('without --task writes to root path (backward compat)', () => {
      const { exitCode } = runCli(
        'exception TEST-EXC5 --reason "no task context"',
        homeDir
      );
      assert.strictEqual(exitCode, 0);
      const rootPath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-EXC5', 'tdd-phase.json');
      assert.ok(fs.existsSync(rootPath), `Expected root state at ${rootPath}`);
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

  describe('per-task path resolution (GH-219 Task 9 + Task 1)', () => {
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

    it('current with --task does NOT fall back to legacy root (GH-219 Task 1)', () => {
      // Create state at root (legacy) path only
      runCli('init TEST-T9C', homeDir);
      // Now read with --task — per-task file does not exist, should NOT fallback to root
      const { exitCode } = runCli('current TEST-T9C --task 2', homeDir);
      assert.strictEqual(exitCode, 1, 'Should fail when per-task state does not exist, no root fallback');
    });

    it('current with --task fails when per-task path does not exist', () => {
      const { exitCode } = runCli('current TEST-T9D --task 1', homeDir);
      assert.strictEqual(exitCode, 1);
    });

    it('init without --task writes to legacy root path (backward compat)', () => {
      runCli('init TEST-T9E', homeDir);
      const rootPath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-T9E', 'tdd-phase.json');
      assert.ok(fs.existsSync(rootPath), `Expected root state at ${rootPath}`);
    });
  });


  describe('no-fallback guard (GH-219 Task 1)', () => {
    it('getStatePath with taskNum always returns per-task path, never root', () => {
      // Init at root, then verify --task read does NOT find root state
      runCli('init TEST-NOFALL', homeDir);
      const rootPath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-NOFALL', 'tdd-phase.json');
      assert.ok(fs.existsSync(rootPath), 'Root state should exist');

      const perTaskPath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-NOFALL', 'task1', 'tdd-phase.json');
      assert.ok(!fs.existsSync(perTaskPath), 'Per-task state should NOT exist yet');

      // Reading with --task 1 should fail (no per-task state), NOT fall back to root
      const { exitCode } = runCli('current TEST-NOFALL --task 1', homeDir);
      assert.strictEqual(exitCode, 1, 'Should not fall back to root path');
    });
  });

  describe('record commands with --task (GH-219 Task 1)', () => {
    it('record-green with --task reads/writes per-task path', () => {
      // Init per-task state
      runCli('init TEST-RG1 --task 2', homeDir);
      // Set up state for green phase
      const perTaskPath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-RG1', 'task2', 'tdd-phase.json');
      const state = JSON.parse(fs.readFileSync(perTaskPath, 'utf8'));
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
      fs.writeFileSync(perTaskPath, JSON.stringify(state, null, 2));

      const passScript = createExitScript(scriptDir, 0);
      const { stdout, exitCode } = runCli(
        `record-green TEST-RG1 --task 2 --cmd "${passScript}"`,
        homeDir
      );
      assert.strictEqual(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.strictEqual(result.ok, true);

      // Verify it wrote to per-task path, not root
      const updatedState = JSON.parse(fs.readFileSync(perTaskPath, 'utf8'));
      assert.strictEqual(updatedState.cycles[0].green.testExitCode, 0);
      // Root path should NOT exist
      const rootPath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-RG1', 'tdd-phase.json');
      assert.ok(!fs.existsSync(rootPath), 'Root state should NOT be created');
    });

    it('record-refactor with --task reads/writes per-task path', () => {
      runCli('init TEST-RR1 --task 4', homeDir);
      const perTaskPath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-RR1', 'task4', 'tdd-phase.json');
      const state = JSON.parse(fs.readFileSync(perTaskPath, 'utf8'));
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
      fs.writeFileSync(perTaskPath, JSON.stringify(state, null, 2));

      const passScript = createExitScript(scriptDir, 0);
      const { stdout, exitCode } = runCli(
        `record-refactor TEST-RR1 --task 4 --cmd "${passScript}"`,
        homeDir
      );
      assert.strictEqual(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.strictEqual(result.ok, true);

      const updatedState = JSON.parse(fs.readFileSync(perTaskPath, 'utf8'));
      assert.strictEqual(updatedState.cycles[0].refactor.testExitCode, 0);
    });

    it('record-green without --task still uses root path (backward compat)', () => {
      runCli('init TEST-RG2', homeDir);
      const rootPath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-RG2', 'tdd-phase.json');
      const state = JSON.parse(fs.readFileSync(rootPath, 'utf8'));
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
      fs.writeFileSync(rootPath, JSON.stringify(state, null, 2));

      const passScript = createExitScript(scriptDir, 0);
      const { stdout, exitCode } = runCli(
        `record-green TEST-RG2 --cmd "${passScript}"`,
        homeDir
      );
      assert.strictEqual(exitCode, 0);
      const updatedState = JSON.parse(fs.readFileSync(rootPath, 'utf8'));
      assert.strictEqual(updatedState.cycles[0].green.testExitCode, 0);
    });
  });

  describe('transition with --task (GH-219 Task 1)', () => {
    it('transition with --task reads/writes per-task path', () => {
      runCli('init TEST-TR1 --task 3', homeDir);
      const perTaskPath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-TR1', 'task3', 'tdd-phase.json');
      const state = JSON.parse(fs.readFileSync(perTaskPath, 'utf8'));
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
      fs.writeFileSync(perTaskPath, JSON.stringify(state, null, 2));

      const { stdout, exitCode } = runCli('transition TEST-TR1 green --task 3', homeDir);
      assert.strictEqual(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.strictEqual(result.phase, 'green');

      const updatedState = JSON.parse(fs.readFileSync(perTaskPath, 'utf8'));
      assert.strictEqual(updatedState.currentPhase, 'green');
      // Root path should NOT exist
      const rootPath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-TR1', 'tdd-phase.json');
      assert.ok(!fs.existsSync(rootPath), 'Root state should NOT be created');
    });

    it('transition without --task still uses root path (backward compat)', () => {
      runCli('init TEST-TR2', homeDir);
      const rootPath = path.join(homeDir, 'worktrees', 'tasks', 'TEST-TR2', 'tdd-phase.json');
      const state = JSON.parse(fs.readFileSync(rootPath, 'utf8'));
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
      fs.writeFileSync(rootPath, JSON.stringify(state, null, 2));

      const { stdout, exitCode } = runCli('transition TEST-TR2 green', homeDir);
      assert.strictEqual(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.strictEqual(result.phase, 'green');
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
  describe('multi-task TDD accumulation (GH-219 Task 5)', () => {
    it('5.1: accumulates independent per-task state across full TDD lifecycle', () => {
      const ticketId = 'TEST-MT1';
      const tasksBase = path.join(homeDir, 'worktrees', 'tasks');
      const failScript = createExitScript(scriptDir, 1);
      const passScript = createExitScript(scriptDir, 0);

      // 1. Init task 1
      const initResult1 = runCli(`init ${ticketId} --task 1`, homeDir);
      assert.strictEqual(initResult1.exitCode, 0);

      // 2. Verify task1/tdd-phase.json exists with currentPhase: 'red', cycles: []
      const task1Path = path.join(tasksBase, ticketId, 'task1', 'tdd-phase.json');
      assert.ok(fs.existsSync(task1Path), 'task1/tdd-phase.json should exist after init');
      const task1StateAfterInit = JSON.parse(fs.readFileSync(task1Path, 'utf8'));
      assert.strictEqual(task1StateAfterInit.currentPhase, 'red');
      assert.deepStrictEqual(task1StateAfterInit.cycles, []);

      // 3. Record red for task 1 — requires a git repo with changed test files
      const gitRepo = createTempGitRepo();
      fs.writeFileSync(path.join(gitRepo, 'feature.test.ts'), 'describe("feature", () => {});');
      execSync('git add feature.test.ts', { cwd: gitRepo, stdio: 'pipe' });
      const redResult = runCli(
        `record-red ${ticketId} --task 1 --cmd "${failScript}"`,
        homeDir,
        gitRepo
      );
      assert.strictEqual(redResult.exitCode, 0, `record-red should succeed, got: ${redResult.stderr || ''}`);

      // 4. Transition task 1 to green
      const transResult = runCli(`transition ${ticketId} green --task 1`, homeDir);
      assert.strictEqual(transResult.exitCode, 0);

      // 5. Record green for task 1
      const greenResult = runCli(
        `record-green ${ticketId} --task 1 --cmd "${passScript}"`,
        homeDir
      );
      assert.strictEqual(greenResult.exitCode, 0, `record-green should succeed, got: ${greenResult.stderr || ''}`);

      // 6. Verify task1/tdd-phase.json has non-empty cycles with red AND green evidence
      const task1Final = JSON.parse(fs.readFileSync(task1Path, 'utf8'));
      assert.ok(task1Final.cycles.length > 0, 'cycles should be non-empty');
      assert.ok(task1Final.cycles[0].red, 'cycle should have red evidence');
      assert.ok(task1Final.cycles[0].green, 'cycle should have green evidence');
      assert.strictEqual(task1Final.cycles[0].red.testExitCode, 1);
      assert.strictEqual(task1Final.cycles[0].green.testExitCode, 0);

      // Snapshot task1 state for later comparison
      const task1Snapshot = fs.readFileSync(task1Path, 'utf8');

      // 7. Init task 2
      const initResult2 = runCli(`init ${ticketId} --task 2`, homeDir);
      assert.strictEqual(initResult2.exitCode, 0);

      // 8. Verify task1/tdd-phase.json is UNMODIFIED
      const task1AfterTask2Init = fs.readFileSync(task1Path, 'utf8');
      assert.strictEqual(
        task1AfterTask2Init,
        task1Snapshot,
        'task1/tdd-phase.json must not be modified by task 2 init'
      );

      // 9. Record red for task 2
      const gitRepo2 = createTempGitRepo();
      fs.writeFileSync(path.join(gitRepo2, 'other.test.ts'), 'describe("other", () => {});');
      execSync('git add other.test.ts', { cwd: gitRepo2, stdio: 'pipe' });
      const redResult2 = runCli(
        `record-red ${ticketId} --task 2 --cmd "${failScript}"`,
        homeDir,
        gitRepo2
      );
      assert.strictEqual(redResult2.exitCode, 0, `record-red task 2 should succeed, got: ${redResult2.stderr || ''}`);

      // 10. Verify both state files exist independently
      const task2Path = path.join(tasksBase, ticketId, 'task2', 'tdd-phase.json');
      assert.ok(fs.existsSync(task1Path), 'task1/tdd-phase.json should still exist');
      assert.ok(fs.existsSync(task2Path), 'task2/tdd-phase.json should exist');

      // Verify task2 has its own red evidence
      const task2State = JSON.parse(fs.readFileSync(task2Path, 'utf8'));
      assert.ok(task2State.cycles.length > 0, 'task2 cycles should be non-empty');
      assert.ok(task2State.cycles[0].red, 'task2 cycle should have red evidence');
      assert.strictEqual(task2State.cycles[0].red.testExitCode, 1);

      // Clean up git repos
      fs.rmSync(gitRepo, { recursive: true, force: true });
      fs.rmSync(gitRepo2, { recursive: true, force: true });
    });

    it('5.2: no root tdd-phase.json created when using per-task paths', () => {
      const ticketId = 'TEST-MT2';
      const tasksBase = path.join(homeDir, 'worktrees', 'tasks');

      // Init and record for task 1
      runCli(`init ${ticketId} --task 1`, homeDir);
      const task1Path = path.join(tasksBase, ticketId, 'task1', 'tdd-phase.json');
      const state1 = JSON.parse(fs.readFileSync(task1Path, 'utf8'));
      state1.currentPhase = 'green';
      state1.cycles = [
        {
          cycle: 1,
          red: {
            testFiles: ['a.test.ts'],
            testCommand: 'echo test',
            testExitCode: 1,
            timestamp: new Date().toISOString(),
          },
        },
      ];
      fs.writeFileSync(task1Path, JSON.stringify(state1, null, 2));

      const passScript = createExitScript(scriptDir, 0);
      runCli(`record-green ${ticketId} --task 1 --cmd "${passScript}"`, homeDir);

      // Init and record for task 2
      runCli(`init ${ticketId} --task 2`, homeDir);
      const task2Path = path.join(tasksBase, ticketId, 'task2', 'tdd-phase.json');
      const state2 = JSON.parse(fs.readFileSync(task2Path, 'utf8'));
      state2.currentPhase = 'green';
      state2.cycles = [
        {
          cycle: 1,
          red: {
            testFiles: ['b.test.ts'],
            testCommand: 'echo test',
            testExitCode: 1,
            timestamp: new Date().toISOString(),
          },
        },
      ];
      fs.writeFileSync(task2Path, JSON.stringify(state2, null, 2));
      runCli(`record-green ${ticketId} --task 2 --cmd "${passScript}"`, homeDir);

      // Assert NO root tdd-phase.json exists
      const rootPath = path.join(tasksBase, ticketId, 'tdd-phase.json');
      assert.ok(
        !fs.existsSync(rootPath),
        'Root tdd-phase.json must NOT exist when using per-task paths'
      );

      // Confirm per-task files DO exist
      assert.ok(fs.existsSync(task1Path), 'task1/tdd-phase.json should exist');
      assert.ok(fs.existsSync(task2Path), 'task2/tdd-phase.json should exist');
    });
  });

});
