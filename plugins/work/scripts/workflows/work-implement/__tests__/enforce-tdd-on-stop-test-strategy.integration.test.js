/**
 * GH-610 Task 3 — Stop hook resolves via synthesis/citation fallback.
 *
 * `enforce-tdd-on-stop.js` historically read ONLY `currentTask?.testCommand`
 * (the verbatim legacy `### Test Command`). When a task is authored with a
 * `### Test Strategy` block instead (the GH-590 flow), `testCommand` is null and
 * the hook silently took its "no test command → allow stop" bypass — letting an
 * agent stop with no TDD evidence at all.
 *
 * Task 3 wires the hook to the shared resolution path so that, when the flag is
 * ON and the task carries a `### Test Strategy`:
 *   - envelope kinds (unit/integration/e2e/custom) resolve to a SYNTHESIZED
 *     command which the hook auto-runs/records (no more bypass);
 *   - citation kinds (verified-by/wiring-citation) are satisfied by existing
 *     citation green evidence rather than failing on a missing command;
 *   - the legacy "no command AND no strategy → allow stop" bypass is preserved;
 *   - the fail-open hook convention is preserved.
 *
 * RED-phase scenarios covered (verbatim titles must match task-next.js scope):
 *   - Synthesizable Test-Strategy task resolves a command instead of bypassing
 *   - Citation-kind task is satisfied by citation green evidence
 *   - Legacy/no-strategy task keeps the allow-stop bypass
 *
 * Run with:
 *   node --test scripts/workflows/work-implement/__tests__/enforce-tdd-on-stop-test-strategy.integration.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'enforce-tdd-on-stop.js');

const ORIGINAL_FLAG = process.env.WORK_TEST_STRATEGY_VALIDATOR;

let homeDir;
let tasksBase;
let worktreeDir;

function mkTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh610-task3-int-'));
  fs.mkdirSync(path.join(dir, 'worktrees', 'tasks'), { recursive: true });
  return dir;
}

/**
 * Spawn the SubagentStop hook the way Claude Code does: feed it the hook JSON on
 * stdin, with WORK_TICKET_ID + TASKS_BASE pointing at our temp fixtures.
 *
 * `extraEnv` lets a scenario export the test-command envelope var (e.g.
 * TEST_INTEGRATION_COMMAND) that the synthesized command shells out to.
 */
function runHook(ticket, extraEnv = {}) {
  const res = spawnSync(process.execPath, [HOOK_PATH], {
    encoding: 'utf8',
    cwd: worktreeDir,
    input: JSON.stringify({ stop_hook_active: false }),
    env: {
      ...process.env,
      HOME: homeDir,
      TASKS_BASE: tasksBase,
      WORK_TICKET_ID: ticket,
      WORK_TEST_STRATEGY_VALIDATOR: '1',
      WORK_TDD_TOKEN_SKIP: '1',
      WORK_TDD_SKIP_WORKSPACE_CHECK: '1',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    exitCode: typeof res.status === 'number' ? res.status : 1,
  };
}

function ticketDir(ticket) {
  return path.join(tasksBase, ticket);
}

function readDebug(ticket) {
  const p = path.join(ticketDir(ticket), 'debug.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// Seed a `.work-state.json` putting the implement step in_progress and pointing
// the hook at `taskNum` (currentTaskIndex is 0-based; taskNum = idx + 1).
function writeWorkState(ticket, taskNum, nTasks = taskNum) {
  const dir = ticketDir(ticket);
  fs.mkdirSync(dir, { recursive: true });
  const tasks = Array.from({ length: nTasks }, (_, i) => ({ num: i + 1 }));
  fs.writeFileSync(
    path.join(dir, '.work-state.json'),
    JSON.stringify(
      {
        ticketId: ticket,
        stepStatus: { implement: 'in_progress' },
        worktreeDir,
        tasksMeta: { currentTaskIndex: taskNum - 1, tasks },
      },
      null,
      2
    )
  );
}

// A worktree-rooted `.envrc` exporting the envelope var used by synthesis.
function writeEnvrc(varName, value) {
  fs.writeFileSync(
    path.join(worktreeDir, '.envrc'),
    `export ${varName}=${JSON.stringify(value)}\n`
  );
}

// Single-task tasks.md: a backend task carrying a `### Test Strategy` block and
// (deliberately) NO `### Test Command`.
function writeStrategyTasksMd(ticket, { strategyLines, scope = ['src/wiring.js'] }) {
  const dir = ticketDir(ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'tasks.md'),
    [
      '## Task 1 — Strategy-authored task',
      '',
      '### Type',
      'backend',
      '',
      '### Files in scope',
      ...scope.map((f) => `- ${f}`),
      '',
      '### Test Strategy',
      '```',
      ...strategyLines,
      '```',
      '',
    ].join('\n')
  );
}

// A citing task (Task 2) plus a peer (Task 1) whose unit entry covers Task 2's
// scope — the shape that yields a valid peer citation.
function writeCitationTasksMd(ticket, { citingKind }) {
  const dir = ticketDir(ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'tasks.md'),
    [
      '## Task 1 — Peer with real tests',
      '',
      '### Type',
      'backend',
      '',
      '### Files in scope',
      '- src/wiring.js',
      '',
      '### Test Strategy',
      '```',
      'kind: unit',
      'entry: src/wiring.test.js',
      '```',
      '',
      '## Task 2 — Citing task',
      '',
      '### Type',
      'backend',
      '',
      '### Files in scope',
      '- src/wiring.js',
      '',
      '### Test Strategy',
      '```',
      `kind: ${citingKind}`,
      'peer: Task 1',
      '```',
      '',
    ].join('\n')
  );
}

// Pre-populate a completed RED→GREEN citation cycle so the stop-hook evidence
// check (readTddEvidence/validateTddEvidence) sees a valid completed cycle.
function seedCitationGreenEvidence(ticket, taskNum) {
  const dir = path.join(ticketDir(ticket), `task${taskNum}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'tdd-phase.json'),
    JSON.stringify(
      {
        ticket,
        task: taskNum,
        currentPhase: 'refactor',
        currentCycle: 1,
        cycles: [
          {
            cycle: 1,
            red: {
              testFiles: ['src/wiring.test.js'],
              testCommand: 'false',
              testExitCode: 1,
              timestamp: new Date().toISOString(),
            },
            green: {
              kind: 'verified-by',
              peer: 'Task 1',
              peerSha: 'a'.repeat(40),
              scopeOverlap: true,
              recordedAt: new Date().toISOString(),
            },
          },
        ],
      },
      null,
      2
    )
  );
}

describe('GH-610 Task 3 — stop hook synthesis/citation fallback', () => {
  beforeEach(() => {
    homeDir = mkTempHome();
    tasksBase = path.join(homeDir, 'worktrees', 'tasks');
    worktreeDir = path.join(homeDir, 'worktrees', 'wt');
    fs.mkdirSync(worktreeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    if (ORIGINAL_FLAG === undefined) delete process.env.WORK_TEST_STRATEGY_VALIDATOR;
    else process.env.WORK_TEST_STRATEGY_VALIDATOR = ORIGINAL_FLAG;
  });

  // Verbatim scenario — do not rename.
  it('Synthesizable Test-Strategy task resolves a command instead of bypassing', () => {
    const ticket = 'TEST-STOP-SYNTH';
    writeWorkState(ticket, 1);
    // kind=integration with an entry → synthesizes
    //   CHANGED_FILES="src/wiring.test.js" eval "$TEST_INTEGRATION_COMMAND"
    writeStrategyTasksMd(ticket, {
      strategyLines: ['kind: integration', 'entry: src/wiring.test.js'],
    });
    // Make the synthesized command FAIL so RED is recorded and the hook blocks.
    writeEnvrc('TEST_INTEGRATION_COMMAND', 'exit 1');

    const res = runHook(ticket, { TEST_INTEGRATION_COMMAND: 'exit 1' });

    // The hook must NOT take the legacy "no test command → allow stop" bypass.
    const debug = readDebug(ticket);
    assert.doesNotMatch(
      debug,
      /No ### Test Command in tasks\.md — evidence check skipped/,
      `hook must resolve via Test Strategy, not bypass.\ndebug:\n${debug}\nstderr:\n${res.stderr}`
    );
    // A failing synthesized command in RED blocks the stop (exit 2), records RED,
    // and never allows the agent to stop with zero evidence.
    assert.equal(
      res.exitCode,
      2,
      `expected RED-recorded block (exit 2), got ${res.exitCode}\nstderr: ${res.stderr}\ndebug:\n${debug}`
    );
    // A per-task phase state must now exist (the command was actually resolved+run).
    const phasePath = path.join(ticketDir(ticket), 'task1', 'tdd-phase.json');
    assert.ok(
      fs.existsSync(phasePath),
      `expected tdd-phase.json to be created via synthesized command\ndebug:\n${debug}`
    );
  });

  // Verbatim scenario — do not rename.
  it('Citation-kind task is satisfied by citation green evidence', () => {
    const ticket = 'TEST-STOP-CITE';
    writeWorkState(ticket, 2);
    writeCitationTasksMd(ticket, { citingKind: 'verified-by' });
    seedCitationGreenEvidence(ticket, 2);

    const res = runHook(ticket);

    // Citation green is a valid completed cycle → stop is allowed (exit 0) and
    // NO command is executed for the citation kind.
    assert.equal(
      res.exitCode,
      0,
      `citation green should satisfy the gate (exit 0), got ${res.exitCode}\nstderr: ${res.stderr}`
    );
    const debug = readDebug(ticket);
    assert.doesNotMatch(
      debug,
      /AUTO-RUN FAILED|recording failed/,
      `citation kind must not attempt to execute a command.\ndebug:\n${debug}`
    );
  });

  // Verbatim scenario — do not rename. Regression: the legacy bypass survives.
  it('Legacy/no-strategy task keeps the allow-stop bypass', () => {
    const ticket = 'TEST-STOP-LEGACY';
    writeWorkState(ticket, 1);
    // A task with neither a `### Test Command` nor a `### Test Strategy`.
    const dir = ticketDir(ticket);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'tasks.md'),
      [
        '## Task 1 — Bare task',
        '',
        '### Type',
        'backend',
        '',
        '### Files in scope',
        '- src/x.js',
        '',
      ].join('\n')
    );

    const res = runHook(ticket);

    // No command and no strategy → allow stop (bypass preserved).
    assert.equal(
      res.exitCode,
      0,
      `bare task must keep the allow-stop bypass (exit 0), got ${res.exitCode}\nstderr: ${res.stderr}`
    );
    const debug = readDebug(ticket);
    assert.match(
      debug,
      /No ### Test Command in tasks\.md — evidence check skipped/,
      `expected the legacy bypass marker in debug.md.\ndebug:\n${debug}`
    );
  });
});
