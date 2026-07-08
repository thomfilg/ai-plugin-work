/**
 * GH-610 Task 1 — end-to-end implement gate over a `### Test Strategy`
 * (kind=integration) task with the flag ON and NO `### Test Command`.
 *
 * RED: the gate currently reads only `### Test Command`, so a strategy-only
 * task wedges at "test command is missing or unrunnable". This drives the
 * full `dispatchAdvanceGate` pre-test → post-test cycle against the
 * SYNTHESIZED command (resolved from a worktree-rooted `.envrc`).
 *
 * Scenario covered:
 *   - Test-Strategy task flows through the implement gate end-to-end without
 *     wedging.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const implementGate = require('../lib/step-enrichments/implement-gate');

const ORIGINAL_FLAG = process.env.WORK_TEST_STRATEGY_VALIDATOR;

let tmp;
let tasksBase;
let tasksDir;
let worktreeDir;
let flagFile;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh610-task1-int-'));
  tasksBase = path.join(tmp, 'tasks');
  tasksDir = path.join(tasksBase, 'GH-TEST');
  worktreeDir = path.join(tmp, 'wt');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(worktreeDir, { recursive: true });

  // The synthesized command runs `node check.js`: it exits 1 while the
  // green marker is absent (RED), and 0 once it exists (GREEN). We point
  // TEST_INTEGRATION_COMMAND at that script via the worktree `.envrc` so the
  // gate must resolve `.envrc` from the worktree root.
  flagFile = path.join(worktreeDir, 'green.marker');
  const checkScript = path.join(worktreeDir, 'check.js');
  // Noisy on success: the gate now applies the recorder's RC-D empty-output
  // trap (gate-writer.js writeGateGreen), so a zero-output exit-0 run would
  // be refused — like a real test runner, the fixture emits a summary line.
  fs.writeFileSync(
    checkScript,
    `const fs=require('fs');const ok=fs.existsSync(${JSON.stringify(flagFile)});console.log(ok?'1 passing':'1 failing');process.exit(ok?0:1);\n`
  );
  fs.writeFileSync(
    path.join(worktreeDir, '.envrc'),
    `export TEST_INTEGRATION_COMMAND="node ${checkScript}"\n`
  );

  fs.writeFileSync(
    path.join(tasksDir, 'tasks.md'),
    [
      '## Task 1 — Strategy-only integration task',
      '',
      '### Type',
      'backend',
      '',
      '### Files in scope',
      '- src/foo.js',
      '',
      '### Test Strategy',
      '```',
      'kind: integration',
      'entry: src/foo.integration.test.js',
      '```',
      '',
    ].join('\n')
  );

  process.env.WORK_TEST_STRATEGY_VALIDATOR = '1';
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.WORK_TEST_STRATEGY_VALIDATOR;
  else process.env.WORK_TEST_STRATEGY_VALIDATOR = ORIGINAL_FLAG;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeState() {
  return {
    ticketId: 'GH-TEST',
    worktreeDir,
    tasksMeta: {
      totalTasks: 1,
      currentTaskIndex: 0,
      tasks: [{ id: 'task_1', status: 'pending' }],
    },
  };
}

function makeDeps(state) {
  const tddEnf = require('../lib/tdd-enforcement');
  return {
    loadWorkState: () => state,
    saveWorkState: (_safe, ws) => {
      Object.assign(state, ws);
    },
    readTddEvidence: (safe, step, taskNum) =>
      tddEnf.readTddEvidence(tasksBase, safe, step, taskNum),
    validateTddEvidence: (evidence) => {
      const c = evidence?.cycles?.[0];
      const valid = !!(c && c.red && c.green);
      return { valid, reason: valid ? '' : 'incomplete cycle' };
    },
    stepName: 'implement',
    workDir: path.join(__dirname, '..', '..', '..', 'work-implement'),
    log: Object.assign(() => {}, { recurse: () => {} }),
    recursionDepth: 0,
  };
}

describe('Test-Strategy task flows through the implement gate end-to-end without wedging', () => {
  it('records authentic RED via the synthesized command (no missing-command wedge)', () => {
    const state = makeState();
    const ctx = { tasksDir, worktreeDir };

    // First gate pass → runs the pre-implement test (synthesized command).
    // The command fails (no green marker) → authentic RED recorded.
    implementGate.dispatchAdvanceGate('GH-TEST', ctx, makeDeps(state));

    // The gate must NOT have wedged with a missing/unrunnable command.
    assert.doesNotMatch(
      String(state._tddRetryReason || ''),
      /test command is missing or unrunnable/i,
      'strategy-only task must not wedge on a missing command'
    );

    const evidencePath = path.join(tasksDir, 'task1', 'tdd-phase.json');
    assert.ok(fs.existsSync(evidencePath), 'expected RED evidence file to be written');
    const ev = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    assert.equal(ev.currentPhase, 'red');
    assert.equal(ev.cycles[0].red.testExitCode, 1);
    assert.match(ev.cycles[0].red.testCommand, /TEST_INTEGRATION_COMMAND|check\.js/);
  });

  it('advances RED → GREEN once the synthesized command passes', () => {
    const state = makeState();
    const ctx = { tasksDir, worktreeDir };

    // Pass 1: pre-test → RED.
    implementGate.dispatchAdvanceGate('GH-TEST', ctx, makeDeps(state));

    // Simulate the agent making the test pass.
    fs.writeFileSync(flagFile, 'ok');

    // Pass 2: post-test runs the synthesized command, now passing → GREEN.
    implementGate.dispatchAdvanceGate('GH-TEST', ctx, makeDeps(state));

    const evidencePath = path.join(tasksDir, 'task1', 'tdd-phase.json');
    const ev = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    assert.ok(ev.cycles[0].green, 'expected a GREEN entry after the command passes');
    assert.equal(ev.cycles[0].green.testExitCode, 0);
  });
});
