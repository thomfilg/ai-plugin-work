/**
 * GH-610 Task 2 — Citation-kind evidence recording in `tdd-phase-state.js`.
 *
 * For `verified-by` / `wiring-citation` Test Strategy kinds, `synthesizeCommand`
 * returns `null` by design (the citing task piggybacks on a peer's tests).
 * Instead of executing a command, the recorder must:
 *   - validate the peer pointer via `validatePeerCitation(strategy, allTasks, citingTask)`,
 *   - on an empty error array, record a green evidence entry
 *     `{ kind, peer, peerSha, scopeOverlap: true, recordedAt }` with NO command run,
 *   - on a non-empty error array, surface the coverage error strings and record
 *     NO evidence.
 *
 * RED-phase scenarios covered (verbatim titles must match task-next.js scope):
 *   - Citation-kind task records evidence by peer citation, not command execution
 *   - Invalid peer citation surfaces an actionable error
 *
 * Run with:
 *   node --test scripts/workflows/work-implement/__tests__/tdd-phase-state-test-strategy.integration.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const CLI_PATH = path.join(__dirname, '..', 'tdd-phase-state.js');

const ORIGINAL_FLAG = process.env.WORK_TEST_STRATEGY_VALIDATOR;

let homeDir;
let tasksBase;

function mkTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh610-task2-int-'));
  fs.mkdirSync(path.join(dir, 'worktrees', 'tasks'), { recursive: true });
  return dir;
}

function runCli(args) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      TASKS_BASE: tasksBase,
      WORK_TEST_STRATEGY_VALIDATOR: '1',
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

function statePath(ticket, taskNum) {
  return path.join(tasksBase, ticket, `task${taskNum}`, 'tdd-phase.json');
}

function readState(ticket, taskNum) {
  return JSON.parse(fs.readFileSync(statePath(ticket, taskNum), 'utf8'));
}

// Seed a GREEN-phase per-task state for the citing task so `record-green`
// is phase-valid. RED evidence is pre-populated so the cycle is mid-flight.
function seedGreenPhase(ticket, taskNum) {
  runCli(['init', ticket, '--task', String(taskNum)]);
  const sp = statePath(ticket, taskNum);
  const state = JSON.parse(fs.readFileSync(sp, 'utf8'));
  state.currentPhase = 'green';
  state.cycles = [
    {
      cycle: 1,
      red: {
        testFiles: ['src/wiring.test.js'],
        testCommand: 'false',
        testExitCode: 1,
        timestamp: new Date().toISOString(),
      },
    },
  ];
  fs.writeFileSync(sp, JSON.stringify(state, null, 2));
}

// Write a tasks.md where Task 2 (the citing task) is a verified-by/wiring
// citation pointing at Task 1, whose unit Test Strategy entry lives inside
// Task 2's `### Files in scope` (so the peer covers the citing scope).
function writeTasksMd(ticket, { citingKind, peerEntry, peerScope, citingScope }) {
  const dir = path.join(tasksBase, ticket);
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
      ...peerScope.map((f) => `- ${f}`),
      '',
      '### Test Strategy',
      '```',
      'kind: unit',
      `entry: ${peerEntry}`,
      '```',
      '',
      `## Task 2 — Citing task`,
      '',
      '### Type',
      'backend',
      '',
      '### Files in scope',
      ...citingScope.map((f) => `- ${f}`),
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

describe('GH-610 Task 2 — citation-kind evidence recording', () => {
  beforeEach(() => {
    homeDir = mkTempHome();
    tasksBase = path.join(homeDir, 'worktrees', 'tasks');
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    if (ORIGINAL_FLAG === undefined) delete process.env.WORK_TEST_STRATEGY_VALIDATOR;
    else process.env.WORK_TEST_STRATEGY_VALIDATOR = ORIGINAL_FLAG;
  });

  // Verbatim scenario from tasks.md "Scenarios" list — do not rename.
  it('Citation-kind task records evidence by peer citation, not command execution', () => {
    const ticket = 'TEST-CITE1';
    // Peer (Task 1) unit entry exercises src/wiring.js, which IS Task 2's scope.
    writeTasksMd(ticket, {
      citingKind: 'verified-by',
      peerEntry: 'src/wiring.test.js',
      peerScope: ['src/wiring.js'],
      citingScope: ['src/wiring.js'],
    });
    seedGreenPhase(ticket, 2);

    // record-green WITHOUT --cmd: synthesizeCommand returns null for a
    // citation kind, so the recorder must take the peer-citation path and
    // NOT require/execute a test command.
    const res = runCli(['record-green', ticket, '--task', '2']);
    assert.equal(
      res.exitCode,
      0,
      `expected citation green to succeed, got ${res.exitCode}\nstderr: ${res.stderr}\nstdout: ${res.stdout}`
    );

    const state = readState(ticket, 2);
    const cyc = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(cyc && cyc.green, 'expected green evidence to be recorded');

    // Citation evidence shape: kind + peer + peerSha + scopeOverlap + recordedAt.
    assert.equal(cyc.green.kind, 'verified-by', 'green.kind must be the citation kind');
    assert.equal(cyc.green.peer, 'Task 1', 'green.peer must name the cited peer');
    assert.equal(
      cyc.green.scopeOverlap,
      true,
      'green.scopeOverlap must be true on a valid citation'
    );
    assert.ok(
      typeof cyc.green.peerSha === 'string' && cyc.green.peerSha.length > 0,
      'green.peerSha must be a non-empty string'
    );
    assert.ok(
      typeof cyc.green.recordedAt === 'string' && cyc.green.recordedAt.length > 0,
      'green.recordedAt must be a non-empty timestamp'
    );

    // No command was executed: there must be no recorded testCommand/testExitCode
    // on the citation green entry (that shape belongs to the --cmd path).
    assert.equal(
      cyc.green.testCommand,
      undefined,
      'citation evidence must NOT carry a testCommand (no command executed)'
    );
    assert.equal(
      cyc.green.testExitCode,
      undefined,
      'citation evidence must NOT carry a testExitCode (no command executed)'
    );
  });

  // Verbatim scenario from tasks.md "Scenarios" list — do not rename.
  it('Invalid peer citation surfaces an actionable error', () => {
    const ticket = 'TEST-CITE2';
    // Peer (Task 1) entry exercises src/other.js, which is NOT in Task 2's
    // scope — so validatePeerCitation must report a coverage error.
    writeTasksMd(ticket, {
      citingKind: 'wiring-citation',
      peerEntry: 'src/other.test.js',
      peerScope: ['src/other.js'],
      citingScope: ['src/wiring.js'],
    });
    seedGreenPhase(ticket, 2);

    const res = runCli(['record-green', ticket, '--task', '2']);
    assert.notEqual(res.exitCode, 0, 'invalid peer citation must exit non-zero');
    // Surface the validatePeerCitation coverage error string.
    assert.match(
      res.stderr,
      /does not cover this task's Files in scope/,
      `expected an actionable coverage error, got: ${res.stderr}`
    );

    // No evidence recorded on rejection — the green entry must be absent.
    const state = readState(ticket, 2);
    const cyc = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(!cyc || !cyc.green, 'no green evidence should be recorded on an invalid citation');
    assert.equal(state.currentPhase, 'green', 'phase must remain green on rejection');
  });
});
