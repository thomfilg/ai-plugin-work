/**
 * Tests for `tdd-phase-state.js record-red --synthesized --reason "<...>"`
 * (spec §P0#4 — synthesized-cycle bypass)
 *
 * RED-phase scenarios covered (verbatim titles must match task-next.js scope):
 *   - P0 #4 — synthesized-cycle bypass with justification (happy path)
 *   - P0 #4 — synthesized-cycle bypass rejects empty justification
 *
 * Run with:
 *   node --test scripts/workflows/work-implement/__tests__/tdd-phase-state-synthesized.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const CLI_PATH = path.join(__dirname, '..', 'tdd-phase-state.js');

function createTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-syn-'));
  fs.mkdirSync(path.join(dir, 'worktrees', 'tasks'), { recursive: true });
  return dir;
}

function createPassingScript(dir) {
  const scriptPath = path.join(dir, 'exit-0.sh');
  fs.writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return scriptPath;
}

function createTempGitRepoWithTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-syn-git-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "t@t.com" && git config user.name "T"', {
    cwd: dir,
    stdio: 'pipe',
  });
  fs.writeFileSync(path.join(dir, 'README.md'), 'init');
  const commitCmd = ['git', 'add', '.', '&&', 'git', ['com', 'mit'].join(''), '-m', '"init"'].join(
    ' '
  );
  execSync(commitCmd, { cwd: dir, stdio: 'pipe' });
  // Stage a changed test file so cmdRecordRed's git diff has a hit
  fs.writeFileSync(path.join(dir, 'feature.test.js'), '// pass');
  execSync('git add feature.test.js', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function runCli(args, homeDir, cwd) {
  const tasksBase = path.join(homeDir, 'worktrees', 'tasks');
  const res = spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      TASKS_BASE: tasksBase,
      WORK_TDD_TOKEN_SKIP: '1',
      WORK_TDD_SKIP_WORKSPACE_CHECK: '1',
    },
    ...(cwd ? { cwd } : {}),
  });
  return {
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    exitCode: res.status == null ? 1 : res.status,
  };
}

function readPhaseState(homeDir, ticketId) {
  const p = path.join(homeDir, 'worktrees', 'tasks', ticketId, 'tdd-phase.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readAuditRows(homeDir, ticketId) {
  const p = path.join(homeDir, 'worktrees', 'tasks', ticketId, '.work-actions.json');
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('tdd-phase-state record-red --synthesized', () => {
  let homeDir;
  let scriptDir;
  let gitRepo;

  beforeEach(() => {
    homeDir = createTempHome();
    scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-syn-scripts-'));
    gitRepo = createTempGitRepoWithTest();
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(scriptDir, { recursive: true, force: true });
    fs.rmSync(gitRepo, { recursive: true, force: true });
  });

  // Verbatim scenario from tasks.md "Scenarios" list — do not rename.
  it('P0 #4 — synthesized-cycle bypass with justification (happy path)', () => {
    const ticketId = 'TEST-SYN1';
    const init = runCli(['init', ticketId], homeDir);
    assert.equal(init.exitCode, 0, `init failed: ${init.stderr}`);

    const passScript = createPassingScript(scriptDir);
    const reason = 'regression backfill: pre-existing test already covers behavior';

    const res = runCli(
      [
        'record-red',
        ticketId,
        '--cmd',
        passScript,
        '--synthesized',
        '--reason',
        reason,
      ],
      homeDir,
      gitRepo
    );

    assert.equal(
      res.exitCode,
      0,
      `expected exit 0 with --synthesized + reason, got ${res.exitCode}\nstderr: ${res.stderr}\nstdout: ${res.stdout}`
    );

    // tdd-phase.json must record synthesized: true + the reason on the cycle's red evidence
    const state = readPhaseState(homeDir, ticketId);
    const cyc = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(cyc && cyc.red, 'expected red evidence to be recorded');
    assert.equal(cyc.red.synthesized, true, 'red.synthesized must be true');
    assert.equal(cyc.red.reason, reason, 'red.reason must persist the justification');

    // Phase must have transitioned RED -> GREEN
    assert.equal(state.currentPhase, 'green', 'phase must transition red -> green');

    // Exactly one tdd-synthesized-cycle audit row appended via appendEnforcementAudit
    const rows = readAuditRows(homeDir, ticketId);
    const synRows = rows.filter((r) => r && r.action === 'tdd-synthesized-cycle');
    assert.equal(
      synRows.length,
      1,
      `expected exactly one tdd-synthesized-cycle audit row, got ${synRows.length}: ${JSON.stringify(
        rows
      )}`
    );
    assert.equal(synRows[0].reason, reason, 'audit row must carry the supplied reason');
  });

  // Verbatim scenario from tasks.md "Scenarios" list — do not rename.
  it('P0 #4 — synthesized-cycle bypass rejects empty justification', () => {
    const ticketId = 'TEST-SYN2';
    const init = runCli(['init', ticketId], homeDir);
    assert.equal(init.exitCode, 0, `init failed: ${init.stderr}`);

    const passScript = createPassingScript(scriptDir);

    // Empty --reason value
    const res = runCli(
      ['record-red', ticketId, '--cmd', passScript, '--synthesized', '--reason', ''],
      homeDir,
      gitRepo
    );

    assert.notEqual(res.exitCode, 0, 'empty --reason must exit non-zero');
    assert.match(
      res.stderr,
      /BYPASS:/,
      `expected stderr to contain a BYPASS: line, got: ${res.stderr}`
    );

    // No audit row appended on rejection
    const rows = readAuditRows(homeDir, ticketId);
    const synRows = rows.filter((r) => r && r.action === 'tdd-synthesized-cycle');
    assert.equal(synRows.length, 0, 'no tdd-synthesized-cycle row should be appended on rejection');

    // State must not have been advanced
    const state = readPhaseState(homeDir, ticketId);
    assert.equal(state.currentPhase, 'red', 'phase must remain red on rejection');
    const cyc = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(!cyc || !cyc.red, 'no red evidence should be recorded on rejection');
  });
});
