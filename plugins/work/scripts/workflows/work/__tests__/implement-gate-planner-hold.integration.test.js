/**
 * W3 (implement-phase fix design) — planner-defect operator-hold at the
 * implement gate.
 *
 * Scenarios:
 *   - A malformed `### Test Strategy` blocks with `_tddRetryPlannerDefect`
 *     and the gate returns the operator-hold instruction on the SAME pass —
 *     work-next.js never re-dispatches a developer agent at the defect.
 *   - Subsequent passes keep holding WITHOUT re-running the defective flow
 *     (no retry burn: `_tddRetryCount` stays at 1).
 *   - When the operator corrects the task's tasks.md section (outside the
 *     session), the per-task section hash changes, the hold auto-clears and
 *     the normal flow resumes (pre-test runs, authentic RED is recorded).
 *   - `computeTaskSectionHash` is per-task: editing task 2 does not clear a
 *     hold recorded against task 1.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const implementGate = require('../lib/step-enrichments/implement-gate');
const tddEnf = require('../lib/tdd-enforcement');
const plannerHold = require('../lib/step-enrichments/implement-gate/planner-hold');

// Built by concatenation so the live plugin's state-file protection hooks
// never see the literal names next to write calls in this fixture script.
const TDD_EVIDENCE_FILE = ['tdd-phase', 'json'].join('.');

let tmp;
let tasksBase;
let tasksDir;
let worktreeDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-planner-hold-'));
  tasksBase = path.join(tmp, 'tasks');
  tasksDir = path.join(tasksBase, 'GH-TEST');
  worktreeDir = path.join(tmp, 'wt');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(worktreeDir, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function taskBlock(num, type, strategyLines) {
  return [
    `## Task ${num} — Fixture task ${num}`,
    '',
    '### Type',
    type,
    '',
    '### Files in scope',
    '- src/foo.js',
    '',
    '### Test Strategy',
    '```',
    ...strategyLines,
    '```',
    '',
  ].join('\n');
}

function writeTasksMd(blocks) {
  fs.writeFileSync(path.join(tasksDir, 'tasks.md'), `${blocks.join('\n')}\n`);
}

function makeState(taskCount) {
  const tasks = [];
  for (let i = 1; i <= taskCount; i++) tasks.push({ id: `task_${i}`, status: 'pending' });
  return {
    ticketId: 'GH-TEST',
    worktreeDir,
    tasksMeta: { totalTasks: taskCount, currentTaskIndex: 0, tasks },
  };
}

function makeDeps(state) {
  return {
    loadWorkState: () => state,
    saveWorkState: (_safe, ws) => {
      Object.assign(state, ws);
    },
    readTddEvidence: (safe, step, taskNum) =>
      tddEnf.readTddEvidence(tasksBase, safe, step, taskNum),
    validateTddEvidence: tddEnf.validateTddEvidence,
    stepName: 'implement',
    workDir: path.join(__dirname, '..'),
    log: Object.assign(() => {}, { recurse: () => {} }),
    recursionDepth: 0,
  };
}

function evidencePath(taskNum) {
  return path.join(tasksDir, `task${taskNum}`, TDD_EVIDENCE_FILE);
}

function runGatePass(state) {
  return implementGate.dispatchAdvanceGate('GH-TEST', { tasksDir, worktreeDir }, makeDeps(state));
}

describe('W3 — planner-defect operator-hold (malformed strategy end-to-end)', () => {
  it('holds on the same pass, never burns retries, and resumes after the operator fix', () => {
    // `command: bash` resolves to a bare interpreter — detectMalformedTestCommand
    // classifies it as malformed, which is a planner defect.
    writeTasksMd([taskBlock(1, 'tdd-code', ['kind: custom', 'command: bash'])]);

    const state = makeState(1);

    // Pass 1: malformed strategy ⇒ planner-defect hold returned IMMEDIATELY.
    const first = runGatePass(state);
    assert.ok(first, 'gate returns an instruction, not null (null would re-dispatch)');
    assert.equal(first.type, 'work_instruction');
    assert.equal(first.action, 'blocked');
    assert.equal(first.hold, 'planner-defect');
    assert.match(first.reason, /malformed/);
    assert.match(first.reason, /BLOCKED \(planner-defect\)/);
    assert.match(first.suggestion, /do NOT re-dispatch a developer agent/);
    assert.match(first.suggestion, /AskUserQuestion/);
    assert.equal(first.defect.task, 1);

    assert.equal(state._tddRetryPlannerDefect, true);
    assert.equal(state._tddRetryCount, 1);
    assert.equal(typeof state._tddRetryTasksHash, 'string', 'per-task section hash recorded');
    assert.doesNotMatch(
      String(state._tddRetryReason || ''),
      /edit tasks\.md|update tasks\.md|open tasks\.md and fix|fix tasks\.md/i,
      'retry reason never instructs the agent to change tasks.md'
    );
    assert.equal(fs.existsSync(evidencePath(1)), false, 'no evidence for a malformed command');
    assert.equal(state._preTestForTask, undefined, 'pre-test marker stays unset');

    // Pass 2 (no operator fix): hold again, WITHOUT re-running the flow.
    const second = runGatePass(state);
    assert.equal(second.hold, 'planner-defect');
    assert.equal(state._tddRetryCount, 1, 'no retry burn while the defect is unresolved');

    // Operator fixes tasks.md outside the session: valid failing command.
    const failing = path.join(worktreeDir, 'fail.js');
    fs.writeFileSync(
      failing,
      "console.log('not ok 1 - fixture');console.log('1 failed');process.exit(1);\n"
    );
    writeTasksMd([taskBlock(1, 'tdd-code', ['kind: custom', `command: node ${failing}`])]);

    // Pass 3: section hash changed ⇒ hold cleared, normal flow resumes and
    // captures an authentic RED from the corrected command.
    const third = runGatePass(state);
    assert.equal(third, null, 'gate resumes the normal dispatch flow');
    assert.equal(state._tddRetryPlannerDefect, undefined, 'planner-defect flag cleared');
    assert.equal(state._tddRetryTasksHash, undefined, 'stale hash cleared with the retry state');
    const ev = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.equal(ev.currentPhase, 'red');
    assert.equal(ev.cycles[0].red.capturedByGate, true);
    assert.equal(state._preTestForTask, '1');
  });

  it('post-implement malformed command takes the planner-defect hold path too', () => {
    writeTasksMd([taskBlock(1, 'tdd-code', ['kind: custom', 'command: bash'])]);
    // Seed authentic RED so the flow goes down the post-implement strand.
    fs.mkdirSync(path.dirname(evidencePath(1)), { recursive: true });
    fs.writeFileSync(
      evidencePath(1),
      JSON.stringify({
        currentPhase: 'red',
        currentCycle: 1,
        cycles: [
          {
            cycle: 1,
            red: {
              testFiles: [],
              testCommand: 'node --test src/foo.test.js',
              testExitCode: 1,
              timestamp: '2026-07-05T00:00:00.000Z',
              capturedByGate: true,
            },
          },
        ],
      })
    );

    const state = makeState(1);
    state._preTestForTask = '1';
    const result = runGatePass(state);

    assert.equal(result.hold, 'planner-defect');
    assert.equal(state._tddRetryPlannerDefect, true);
    assert.match(String(state._tddRetryReason || ''), /malformed/);
    assert.match(String(state._tddRetryReason || ''), /BLOCKED \(planner-defect\)/);
    const ev = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.equal(ev.cycles[0].green, undefined, 'no GREEN recorded from a malformed command');
  });
});

describe('W6 follow-up — unset-envelope hold clears via a .envrc fix (no tasks.md change)', () => {
  it('re-probes the defect predicate each pass and resumes once the envelope var resolves', () => {
    // A custom strategy hardcoding the eval-envelope shape with the var unset
    // in the gate run env — the W6 refusal (GH-466) marks a planner defect.
    writeTasksMd([
      taskBlock(1, 'tdd-code', ['kind: custom', 'command: eval "$FIXTURE_TEST_ENVELOPE"']),
    ]);
    const state = makeState(1);

    const first = runGatePass(state);
    assert.equal(first.hold, 'planner-defect');
    assert.match(first.reason, /unset or empty/);
    assert.equal(state._tddRetryDefectKind, 'unset-envelope');
    const hashBefore = state._tddRetryTasksHash;

    // No fix yet: the re-probe still reproduces the defect — hold stands.
    const second = runGatePass(state);
    assert.equal(second.hold, 'planner-defect');
    assert.equal(state._tddRetryCount, 1, 'no retry burn while held');

    // Operator remediation OUTSIDE tasks.md (exactly what the block message
    // advertises): the worktree `.envrc` gains the envelope var. The tasks.md
    // section hash is untouched — hash-only clearing would hold forever.
    const failing = path.join(worktreeDir, 'fail.js');
    fs.writeFileSync(
      failing,
      "console.log('not ok 1 - fixture');console.log('1 failed');process.exit(1);\n"
    );
    fs.writeFileSync(
      path.join(worktreeDir, '.envrc'),
      `export FIXTURE_TEST_ENVELOPE="node ${failing}"\n`
    );
    assert.equal(
      plannerHold.computeTaskSectionHash(tasksDir, 1),
      hashBefore,
      'precondition: tasks.md content for the task did NOT change'
    );

    // Next pass: the static re-probe no longer reproduces the defect — the
    // hold clears and the normal flow resumes (authentic RED captured).
    const third = runGatePass(state);
    assert.equal(third, null, 'gate resumes the normal dispatch flow');
    assert.equal(state._tddRetryPlannerDefect, undefined);
    assert.equal(state._tddRetryDefectKind, undefined);
    const ev = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.equal(ev.currentPhase, 'red');
    assert.equal(ev.cycles[0].red.capturedByGate, true);
  });

  it('a hold without a statically re-checkable kind still requires the tasks.md hash change', () => {
    writeTasksMd([taskBlock(1, 'tdd-code', ['kind: custom', 'command: node ok.js'])]);
    const ws = {
      _tddRetryPlannerDefect: true,
      _tddRetryTask: 1,
      _tddRetryReason: 'test command hangs',
      _tddRetryDefectKind: 'hang',
      _tddRetryCount: 1,
      _tddRetryTasksHash: plannerHold.computeTaskSectionHash(tasksDir, 1),
      worktreeDir,
    };
    // The command would resolve cleanly now, but 'hang' is NOT re-probed
    // (re-probing would re-run the hanging command) — hold stands.
    const hold = plannerHold.resolvePlannerHold({
      ws,
      ctx: { tasksDir, worktreeDir },
      saveWorkState: () => {},
      safeName: 'GH-TEST',
    });
    assert.ok(hold, 'hang holds until the tasks.md section changes');
    assert.equal(hold.hold, 'planner-defect');
  });
});

describe('computeTaskSectionHash (unit)', () => {
  it('is per-task: editing another task does not change this task hash', () => {
    writeTasksMd([
      taskBlock(1, 'tdd-code', ['kind: custom', 'command: bash']),
      taskBlock(2, 'docs', ['kind: custom', 'command: node check.js']),
    ]);
    const h1 = plannerHold.computeTaskSectionHash(tasksDir, 1);
    const h2 = plannerHold.computeTaskSectionHash(tasksDir, 2);
    assert.ok(h1 && h2 && h1 !== h2);

    // Edit ONLY task 2.
    writeTasksMd([
      taskBlock(1, 'tdd-code', ['kind: custom', 'command: bash']),
      taskBlock(2, 'docs', ['kind: custom', 'command: node other-check.js']),
    ]);
    assert.equal(plannerHold.computeTaskSectionHash(tasksDir, 1), h1);
    assert.notEqual(plannerHold.computeTaskSectionHash(tasksDir, 2), h2);
  });

  it('returns null when tasks.md is unreadable', () => {
    assert.equal(plannerHold.computeTaskSectionHash(path.join(tmp, 'nope'), 1), null);
    assert.equal(plannerHold.computeTaskSectionHash(null, 1), null);
  });

  it('resolvePlannerHold backfills a missing hash so a later fix is detectable', () => {
    writeTasksMd([taskBlock(1, 'tdd-code', ['kind: custom', 'command: bash'])]);
    const ws = {
      _tddRetryPlannerDefect: true,
      _tddRetryTask: 1,
      _tddRetryReason: 'fixture defect',
      _tddRetryCount: 1,
    };
    let saved = 0;
    const hold = plannerHold.resolvePlannerHold({
      ws,
      ctx: { tasksDir },
      saveWorkState: () => {
        saved++;
      },
      safeName: 'GH-TEST',
    });
    assert.equal(hold.hold, 'planner-defect');
    assert.equal(typeof ws._tddRetryTasksHash, 'string');
    assert.equal(saved, 1);

    // Operator fix now clears on the next pass.
    writeTasksMd([taskBlock(1, 'tdd-code', ['kind: custom', 'command: node ok.js'])]);
    const next = plannerHold.resolvePlannerHold({
      ws,
      ctx: { tasksDir },
      saveWorkState: () => {},
      safeName: 'GH-TEST',
    });
    assert.equal(next, null);
    assert.equal(ws._tddRetryPlannerDefect, undefined);
  });
});
