/**
 * RC-D --docs-exempt relaxation tests (Task 3, GH-528).
 *
 * Default `record-green` invocation must continue to reject silent
 * verifiers (RC-D empty-command trap). When the new `--docs-exempt` CLI
 * flag is supplied, the same empty-output evidence must be accepted and
 * persisted to disk as a normal `record.green` payload.
 *
 * Mirrors the spawn + mkdtempSync harness from
 * `tdd-phase-state-empty-command-trap.test.js`.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLI_PATH = path.join(__dirname, '..', 'tdd-phase-state.js');

function mkTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-docs-exempt-'));
  fs.mkdirSync(path.join(dir, 'worktrees', 'tasks'), { recursive: true });
  return dir;
}

function runCli(args, homeDir) {
  const argv = Array.isArray(args) ? args : [];
  const res = spawnSync(process.execPath, [CLI_PATH, ...argv], {
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
  return {
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    exitCode: typeof res.status === 'number' ? res.status : 1,
  };
}

function seedGreenPhase(homeDir, ticket) {
  // GH-528 round-2 follow-up (Cursor[bot] HIGH): --docs-exempt requires
  // --task <N> so the recorder can resolve the active task block on disk.
  // Seed with --task 1 (per-task state path) instead of ticket-root.
  runCli(['init', ticket, '--task', '1'], homeDir);
  const statePath = path.join(homeDir, 'worktrees', 'tasks', ticket, 'task1', 'tdd-phase.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.currentPhase = 'green';
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
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  // Plant tasks.md so the Type-gate accepts --docs-exempt for Type=docs.
  fs.writeFileSync(
    path.join(homeDir, 'worktrees', 'tasks', ticket, 'tasks.md'),
    [
      '## Task 1 — sample',
      '',
      '### Type',
      'docs',
      '',
      '### Files in scope',
      '- README.md',
      '',
    ].join('\n')
  );
  return statePath;
}

describe('RC-D --docs-exempt relaxation', () => {
  let homeDir;
  beforeEach(() => {
    homeDir = mkTempHome();
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('tdd-phase-state record-green still rejects silent verifiers by default', () => {
    seedGreenPhase(homeDir, 'TEST-DOCS-1');
    const r = runCli(['record-green', 'TEST-DOCS-1', '--task', '1', '--cmd', 'eval ""'], homeDir);
    assert.notStrictEqual(r.exitCode, 0, 'default invocation must still reject empty output');
    assert.match(r.stderr, /empty-command trap|NO stdout\/stderr/i);
  });

  it('tdd-phase-state record-green accepts silent verifiers when docs-exempt flag is set', () => {
    const statePath = seedGreenPhase(homeDir, 'TEST-DOCS-2');
    const r = runCli(
      ['record-green', 'TEST-DOCS-2', '--task', '1', '--docs-exempt', '--cmd', 'eval ""'],
      homeDir
    );
    assert.strictEqual(
      r.exitCode,
      0,
      `--docs-exempt should accept empty output. stderr: ${r.stderr}`
    );
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const greenRec = state.cycles[0] && state.cycles[0].green;
    assert.ok(greenRec, 'record.green payload should be persisted to disk');
  });
});
