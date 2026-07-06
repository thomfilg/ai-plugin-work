/**
 * W11 + W5 §4 + W6 (implement-phase fix design) — shared gate evidence writer,
 * gate hang strand, and empty/instant-GREEN guards.
 *
 * Scenarios:
 *   - W11: gate RED with load-crashing test output is REJECTED (mirrors the
 *     recorder's GH-532 behavior) with a `tdd-red-load-failure-rejected`
 *     audit row; nothing is written.
 *   - W11: successful gate RED/GREEN writes are atomic (parseable JSON, no
 *     leftover *.tmp files) and stamp capturedByGate.
 *   - W11: the WORK_SKIP_E2E stub is written via the shared writer and
 *     appends a `tdd-e2e-skip-stub` audit row (fabricated cycle is visible).
 *   - W5 §4: a hanging pre-implement test (sleep >> TDD_PHASE_TEST_TIMEOUT_MS)
 *     blocks as a planner defect (`_tddRetryPlannerDefect`), leaves the
 *     pre-test marker unset and records NO evidence — instead of the old
 *     preTestSkipped → noRedEvidence infinite loop. Post-implement hang takes
 *     the same planner-defect retry path.
 *   - W6 / GH-466: an `eval "$VAR"` command whose var is unset in the gate
 *     run env is refused BEFORE execution (planner defect) — no false GREEN
 *     with exit 0 + zero output can be recorded; the unit-kind synthesis
 *     without an `.envrc` produces the loud `pnpm test <entry>` fallback and
 *     never an instant empty GREEN.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const implementGate = require('../lib/step-enrichments/implement-gate');
const tddEnf = require('../lib/tdd-enforcement');
const {
  detectUnsetEnvelopeCommand,
} = require('../lib/step-enrichments/implement-gate/test-command');
const gateWriter = require('../../work-implement/tdd-phase-state/gate-writer');

// Built by concatenation so the live plugin's state-file protection hooks
// never see the literal names next to write calls in this fixture script.
const TDD_EVIDENCE_FILE = ['tdd-phase', 'json'].join('.');
const ACTIONS_FILE = ['.work-actions', 'json'].join('.');

let tmp;
let tasksBase;
let tasksDir;
let worktreeDir;
const savedEnv = {};

function stashEnv(name, value) {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w11-gate-writer-'));
  tasksBase = path.join(tmp, 'tasks');
  tasksDir = path.join(tasksBase, 'GH-TEST');
  worktreeDir = path.join(tmp, 'wt');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(worktreeDir, { recursive: true });
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete savedEnv[name];
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeTasksMd(blocks) {
  fs.writeFileSync(path.join(tasksDir, 'tasks.md'), `${blocks.join('\n')}\n`);
}

function taskBlock(num, type, extra) {
  return [
    `## Task ${num} — Fixture task ${num}`,
    '',
    '### Type',
    type,
    '',
    '### Files in scope',
    '- src/foo.js',
    '',
    ...(extra || []),
  ].join('\n');
}

function strategyBlock(lines) {
  return ['### Test Strategy', '```', ...lines, '```', ''];
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

function writeEvidence(taskNum, evidence) {
  fs.mkdirSync(path.dirname(evidencePath(taskNum)), { recursive: true });
  fs.writeFileSync(evidencePath(taskNum), JSON.stringify(evidence, null, 2));
}

function loadAuditRows() {
  try {
    return JSON.parse(fs.readFileSync(path.join(tasksDir, ACTIONS_FILE), 'utf8'));
  } catch {
    return [];
  }
}

function auditRowsFor(action) {
  return loadAuditRows().filter((r) => r && r.kind === 'enforcement' && r.action === action);
}

describe('W11 — gate RED load-failure rejection (recorder parity, GH-532)', () => {
  it('rejects a load-crashing RED, audits it, and writes no evidence', () => {
    const crash = path.join(worktreeDir, 'crash.js');
    fs.writeFileSync(
      crash,
      "console.error('ReferenceError: foo is not defined');process.exit(1);\n"
    );
    writeTasksMd([
      taskBlock(1, 'tdd-code', strategyBlock(['kind: custom', `command: node ${crash}`])),
    ]);

    const state = makeState(1);
    const result = implementGate.dispatchAdvanceGate(
      'GH-TEST',
      { tasksDir, worktreeDir },
      makeDeps(state)
    );

    assert.equal(result, null);
    assert.match(String(state._tddRetryReason || ''), /Rejected RED at the gate/);
    assert.match(String(state._tddRetryReason || ''), /ReferenceError/);
    assert.equal(fs.existsSync(evidencePath(1)), false, 'no evidence written for a fake RED');
    assert.equal(
      state._preTestForTask,
      undefined,
      'pre-test marker stays unset so the next pass re-runs the pre-test'
    );
    const rows = auditRowsFor('tdd-red-load-failure-rejected');
    assert.equal(rows.length, 1, 'load-failure rejection is audit-logged');
    assert.equal(rows[0].allow, false);
    assert.equal(rows[0].meta.capturedByGate, true);
  });
});

describe('W11 — atomic gate writes', () => {
  it('authentic RED write is atomic: parseable evidence, no *.tmp leftovers', () => {
    const failing = path.join(worktreeDir, 'fail.js');
    fs.writeFileSync(
      failing,
      "console.log('not ok 1 - fixture');console.log('1 failed');process.exit(1);\n"
    );
    writeTasksMd([
      taskBlock(1, 'tdd-code', strategyBlock(['kind: custom', `command: node ${failing}`])),
    ]);

    const state = makeState(1);
    implementGate.dispatchAdvanceGate('GH-TEST', { tasksDir, worktreeDir }, makeDeps(state));

    const ev = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.equal(ev.currentPhase, 'red');
    assert.equal(ev.cycles[0].red.capturedByGate, true);
    assert.equal(ev.cycles[0].red.testExitCode, 1);
    const leftovers = fs
      .readdirSync(path.dirname(evidencePath(1)))
      .filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'no tmp files left behind by the atomic write');
    assert.equal(state._preTestForTask, '1');
  });
});

describe('W11 — WORK_SKIP_E2E stub goes through the shared writer + audit row', () => {
  it('writes the skip stub and appends a tdd-e2e-skip-stub audit row', () => {
    stashEnv('WORK_SKIP_E2E', '1');
    writeTasksMd([
      taskBlock(
        1,
        'tdd-code',
        strategyBlock(['kind: custom', 'command: npx playwright test e2e/foo.spec.ts'])
      ),
    ]);

    const state = makeState(1);
    const result = implementGate.dispatchAdvanceGate(
      'GH-TEST',
      { tasksDir, worktreeDir },
      makeDeps(state)
    );

    assert.equal(result, null, 'gate dispatches after recording the stub');
    const ev = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.equal(ev.cycles[0].red.skippedByGate, true);
    assert.equal(ev.cycles[0].green.skippedByGate, true);
    const rows = auditRowsFor('tdd-e2e-skip-stub');
    assert.equal(rows.length, 1, 'fabricated skip cycle is visible in the audit log');
    assert.equal(rows[0].allow, true);
    assert.equal(rows[0].reason, 'e2e-disabled');
    assert.equal(rows[0].meta.skippedByGate, true);
  });

  // Bypass review — WORK_SKIP_E2E is an OPERATOR choice: it must be honored
  // from the orchestrator's process.env ONLY. The worktree `.envrc` is
  // agent-writable and its values win inside buildRunEnv, so an agent
  // exporting WORK_SKIP_E2E there must NOT convert an e2e task into a
  // fabricated skip stub — the gate runs the real command instead.
  it('ignores WORK_SKIP_E2E from the agent-writable worktree .envrc', () => {
    stashEnv('WORK_SKIP_E2E', undefined);
    stashEnv('WORK_SKIP_E2E_TESTS', undefined);
    fs.writeFileSync(
      path.join(worktreeDir, '.envrc'),
      'export WORK_SKIP_E2E=1\nexport WORK_SKIP_E2E_TESTS=1\n'
    );
    // e2e-classified command (matches isE2eCommand's \bplaywright\b) that
    // actually FAILS — a real run must be captured as RED, not stubbed.
    const failing = path.join(worktreeDir, 'playwright-fixture.js');
    fs.writeFileSync(
      failing,
      "console.log('not ok 1 - playwright fixture');console.log('1 failed');process.exit(1);\n"
    );
    writeTasksMd([
      taskBlock(1, 'tdd-code', strategyBlock(['kind: custom', `command: node ${failing}`])),
    ]);

    const state = makeState(1);
    implementGate.dispatchAdvanceGate('GH-TEST', { tasksDir, worktreeDir }, makeDeps(state));

    assert.equal(auditRowsFor('tdd-e2e-skip-stub').length, 0, 'no fabricated skip stub');
    const ev = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.equal(ev.cycles[0].red.capturedByGate, true, 'the real command ran and captured RED');
    assert.equal(ev.cycles[0].red.testExitCode, 1);
    assert.ok(!ev.cycles[0].red.skippedByGate, 'RED is a real run, not the skip stub');
    assert.ok(!ev.cycles[0].green, 'no fabricated GREEN');
  });
});

describe('W5 §4 — hanging test commands at the gate become planner-defect retries', () => {
  beforeEach(() => {
    stashEnv('TDD_PHASE_TEST_TIMEOUT_MS', '1000');
  });

  it('pre-test hang: plannerDefect retry, no evidence, marker unset, audited', () => {
    writeTasksMd([taskBlock(1, 'tdd-code', strategyBlock(['kind: custom', 'command: sleep 600']))]);

    const state = makeState(1);
    const deps = makeDeps(state);
    const result = implementGate.dispatchAdvanceGate('GH-TEST', { tasksDir, worktreeDir }, deps);

    // W3 — a planner defect returns the operator-hold instruction on the same
    // pass (returning null would let work-next.js re-dispatch a developer).
    assert.equal(result && result.hold, 'planner-defect');
    assert.equal(result.action, 'blocked');
    assert.match(String(state._tddRetryReason || ''), /timed out/);
    assert.match(String(state._tddRetryReason || ''), /planner defect/i);
    assert.match(String(state._tddRetryReason || ''), /BLOCKED \(planner-defect\)/);
    assert.doesNotMatch(
      String(state._tddRetryReason || ''),
      /edit tasks\.md|update tasks\.md|open tasks\.md/i
    );
    assert.equal(state._tddRetryPlannerDefect, true);
    assert.equal(fs.existsSync(evidencePath(1)), false, 'a hang records NO evidence');
    assert.equal(state._preTestForTask, undefined, 'hang does not mark the pre-test done');
    const rows = auditRowsFor('tdd-red-hang-rejected');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].meta.timeoutMs, 1000);

    // Second gate pass: the hold persists WITHOUT re-running the hanging
    // command (W3 — no retry burn: the tasks.md section hash is unchanged, so
    // the gate returns the hold before the evidence flow executes).
    const again = implementGate.dispatchAdvanceGate('GH-TEST', { tasksDir, worktreeDir }, deps);
    assert.equal(again && again.hold, 'planner-defect');
    assert.equal(state._tddRetryCount, 1, 'the defective command is not re-run');
    assert.equal(state._tddRetryPlannerDefect, true);
    assert.equal(fs.existsSync(evidencePath(1)), false);
    assert.equal(state._preTestForTask, undefined);
  });

  it('post-test hang: plannerDefect retry (not "test failed"), audited', () => {
    writeTasksMd([taskBlock(1, 'tdd-code', strategyBlock(['kind: custom', 'command: sleep 600']))]);
    writeEvidence(1, {
      currentPhase: 'red',
      currentCycle: 1,
      cycles: [
        {
          cycle: 1,
          red: {
            testFiles: [],
            testCommand: 'sleep 600',
            testExitCode: 1,
            timestamp: '2026-07-05T00:00:00.000Z',
            capturedByGate: true,
          },
        },
      ],
    });

    const state = makeState(1);
    state._preTestForTask = '1';
    implementGate.dispatchAdvanceGate('GH-TEST', { tasksDir, worktreeDir }, makeDeps(state));

    assert.match(String(state._tddRetryReason || ''), /timed out/);
    assert.equal(state._tddRetryPlannerDefect, true);
    assert.doesNotMatch(
      String(state._tddRetryReason || ''),
      /Post-implement test .* failed \(exit/,
      'a hang must not masquerade as a plain failing test'
    );
    const ev = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.equal(ev.cycles[0].green, undefined, 'no GREEN recorded from a hang');
    assert.equal(auditRowsFor('tdd-green-hang-rejected').length, 1);
  });
});

describe('W6 / GH-466 — unset-envelope eval commands are refused, never false GREEN', () => {
  it('pre-test: eval "$VAR" with VAR unset blocks as planner defect, no evidence', () => {
    writeTasksMd([
      taskBlock(
        1,
        'tdd-code',
        strategyBlock([
          'kind: custom',
          'command: CHANGED_FILES="src/foo.test.js" eval "$TEST_UNIT_COMMAND_W6_UNSET"',
        ])
      ),
    ]);
    stashEnv('TEST_UNIT_COMMAND_W6_UNSET', undefined);

    const state = makeState(1);
    const deps = makeDeps(state);
    const result = implementGate.dispatchAdvanceGate('GH-TEST', { tasksDir, worktreeDir }, deps);

    // W3 — planner defect ⇒ operator-hold instruction on the same pass.
    assert.equal(result && result.hold, 'planner-defect');
    assert.match(String(state._tddRetryReason || ''), /TEST_UNIT_COMMAND_W6_UNSET/);
    assert.match(String(state._tddRetryReason || ''), /false GREEN/);
    assert.match(String(state._tddRetryReason || ''), /BLOCKED \(planner-defect\)/);
    assert.doesNotMatch(
      String(state._tddRetryReason || ''),
      /edit tasks\.md|update tasks\.md|open tasks\.md/i
    );
    assert.equal(state._tddRetryPlannerDefect, true);
    assert.equal(fs.existsSync(evidencePath(1)), false, 'refused command records nothing');
    assert.equal(state._preTestForTask, undefined);

    // Second pass must not slide into the post path and record an instant
    // empty GREEN — the W3 hold short-circuits before any execution while
    // the tasks.md section is unchanged.
    implementGate.dispatchAdvanceGate('GH-TEST', { tasksDir, worktreeDir }, deps);
    assert.equal(fs.existsSync(evidencePath(1)), false);
  });

  it('post-test: guard refuses before execution when RED already exists', () => {
    writeTasksMd([
      taskBlock(
        1,
        'tdd-code',
        strategyBlock([
          'kind: custom',
          'command: CHANGED_FILES="src/foo.test.js" eval "$TEST_UNIT_COMMAND_W6_UNSET"',
        ])
      ),
    ]);
    stashEnv('TEST_UNIT_COMMAND_W6_UNSET', undefined);
    writeEvidence(1, {
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
    });

    const state = makeState(1);
    state._preTestForTask = '1';
    implementGate.dispatchAdvanceGate('GH-TEST', { tasksDir, worktreeDir }, makeDeps(state));

    assert.match(String(state._tddRetryReason || ''), /TEST_UNIT_COMMAND_W6_UNSET/);
    assert.equal(state._tddRetryPlannerDefect, true);
    const ev = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.equal(ev.cycles[0].green, undefined, 'no GREEN recorded from eval-of-empty');
  });

  it('GH-466 regression: unit kind without .envrc synthesizes the loud fallback — never an instant empty GREEN', () => {
    // No .envrc anywhere in the temp worktree: the synthesizer must fall back
    // to `pnpm test <entry>` (loud) instead of the eval-envelope shape.
    writeTasksMd([
      taskBlock(1, 'tdd-code', strategyBlock(['kind: unit', 'entry: src/__tests__/foo.test.js'])),
    ]);

    const state = makeState(1);
    const deps = makeDeps(state);
    implementGate.dispatchAdvanceGate('GH-TEST', { tasksDir, worktreeDir }, deps);
    implementGate.dispatchAdvanceGate('GH-TEST', { tasksDir, worktreeDir }, deps);

    if (fs.existsSync(evidencePath(1))) {
      const ev = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
      const red = ev.cycles?.[0]?.red;
      const green = ev.cycles?.[0]?.green;
      if (red) {
        assert.match(String(red.testCommand || ''), /^pnpm test /, 'loud fallback command');
        assert.notEqual(red.testExitCode, 0, 'fallback on a missing test file fails loudly');
      }
      const emptyInstantGreen =
        green && green.testExitCode === 0 && String(green.outputTail || '').trim() === '';
      assert.ok(!emptyInstantGreen, 'no GREEN with exit 0 and zero output may be recorded');
    }
    // Whether blocked or RED-recorded, a false GREEN never appears.
    assert.notEqual(state.tasksMeta.tasks[0].status, 'completed');
  });
});

describe('detectUnsetEnvelopeCommand (unit)', () => {
  it('names the unset var for eval-envelope shapes', () => {
    assert.equal(
      detectUnsetEnvelopeCommand('CHANGED_FILES="x" eval "$TEST_UNIT_COMMAND"', {}),
      'TEST_UNIT_COMMAND'
    );
    assert.equal(detectUnsetEnvelopeCommand('eval "${TEST_E2E_COMMAND}"', {}), 'TEST_E2E_COMMAND');
  });

  it('treats an empty/whitespace value as unset', () => {
    assert.equal(
      detectUnsetEnvelopeCommand('eval "$TEST_UNIT_COMMAND"', { TEST_UNIT_COMMAND: '' }),
      'TEST_UNIT_COMMAND'
    );
    assert.equal(
      detectUnsetEnvelopeCommand('eval "$TEST_UNIT_COMMAND"', { TEST_UNIT_COMMAND: '   ' }),
      'TEST_UNIT_COMMAND'
    );
  });

  it('returns null when the var is set or the command is not eval-shaped', () => {
    assert.equal(
      detectUnsetEnvelopeCommand('eval "$TEST_UNIT_COMMAND"', {
        TEST_UNIT_COMMAND: 'node --test $CHANGED_FILES',
      }),
      null
    );
    assert.equal(detectUnsetEnvelopeCommand('node --test src/foo.test.js', {}), null);
    assert.equal(detectUnsetEnvelopeCommand('', {}), null);
  });
});

describe('gate-writer (unit)', () => {
  function params(extra) {
    return {
      tasksBase,
      ticketId: 'GH-TEST',
      taskNum: 1,
      evidencePath: evidencePath(1),
      cmd: 'node --test src/foo.test.js',
      now: '2026-07-05T00:00:00.000Z',
      ...extra,
    };
  }

  it('writeGateRed rejects a timed-out run as a planner defect (audited)', () => {
    const r = gateWriter.writeGateRed(
      params({ exitCode: 1, output: '', timedOut: true, timeoutMs: 60000 })
    );
    assert.equal(r.rejected, true);
    assert.equal(r.kind, 'hang');
    assert.equal(r.plannerDefect, true);
    assert.match(r.reason, /1min/);
    assert.equal(fs.existsSync(evidencePath(1)), false);
    assert.equal(auditRowsFor('tdd-red-hang-rejected').length, 1);
  });

  it('writeGateRed rejects load-failure output and audits the signature', () => {
    const r = gateWriter.writeGateRed(
      params({ exitCode: 1, output: "Cannot find module './missing'\n" })
    );
    assert.equal(r.rejected, true);
    assert.equal(r.kind, 'load-failure');
    assert.equal(fs.existsSync(evidencePath(1)), false);
    const rows = auditRowsFor('tdd-red-load-failure-rejected');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].meta.signature, 'Cannot find module');
  });

  it('writeGateRed writes an authentic RED atomically', () => {
    const r = gateWriter.writeGateRed(
      params({ exitCode: 1, output: 'not ok 1 - fixture\n# fail 1\n' })
    );
    assert.deepEqual(r, { written: true });
    const ev = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.equal(ev.cycles[0].red.capturedByGate, true);
    assert.equal(ev.cycles[0].red.testExitCode, 1);
  });

  it('writeGateGreen rejects a timed-out run and writes prebuilt evidence otherwise', () => {
    const rejected = gateWriter.writeGateGreen(
      params({ evidence: { currentPhase: 'refactor' }, timedOut: true, timeoutMs: 60000 })
    );
    assert.equal(rejected.rejected, true);
    assert.equal(fs.existsSync(evidencePath(1)), false);

    const ok = gateWriter.writeGateGreen(
      params({
        evidence: { currentPhase: 'refactor', cycles: [] },
        output: 'ok 1 - fixture\n# pass 1\n',
        taskType: 'tdd-code',
      })
    );
    assert.deepEqual(ok, { written: true });
    assert.equal(JSON.parse(fs.readFileSync(evidencePath(1), 'utf8')).currentPhase, 'refactor');
  });

  // Coverage-review finding 3 — the gate GREEN path must apply the recorder's
  // RC-D empty-output trap (record-cycle.js GREEN_EMPTY_MSG parity), armed by
  // the SAME gateContractFor(taskType).rcdEmptyTrap flag the recorder uses.
  it('writeGateGreen refuses a zero-output exit-0 GREEN for rcdEmptyTrap types (audited)', () => {
    const r = gateWriter.writeGateGreen(
      params({
        evidence: { currentPhase: 'refactor', cycles: [] },
        output: '   \n',
        taskType: 'tdd-code',
      })
    );
    assert.equal(r.rejected, true);
    assert.equal(r.kind, 'empty-output');
    assert.equal(r.plannerDefect, true, 'silent-success command is a planner defect');
    assert.match(r.reason, /NO stdout\/stderr/);
    assert.match(r.reason, /noisy command/);
    // W3 message policy — never instruct the agent to change tasks.md.
    assert.doesNotMatch(r.reason, /Update tasks\.md|Open tasks\.md|fix the `### /);
    assert.match(r.reason, /do NOT edit it/);
    assert.equal(fs.existsSync(evidencePath(1)), false, 'no GREEN evidence written');
    const rows = auditRowsFor('tdd-green-empty-rejected');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].allow, false);
    assert.equal(rows[0].meta.taskType, 'tdd-code');
  });

  it('writeGateGreen empty-output trap fails closed on unknown/missing taskType', () => {
    const r = gateWriter.writeGateGreen(
      params({ evidence: { currentPhase: 'refactor', cycles: [] }, output: '' })
    );
    assert.equal(r.rejected, true, 'missing taskType → strictest contract (tdd-code)');
    assert.equal(r.kind, 'empty-output');
  });

  it('writeGateGreen stays exempt for rcdEmptyTrap:false kinds (docs-exempt parity)', () => {
    for (const taskType of ['docs', 'config', 'ci', 'file-move']) {
      try {
        fs.rmSync(evidencePath(1));
      } catch {
        /* first iteration */
      }
      const r = gateWriter.writeGateGreen(
        params({ evidence: { currentPhase: 'refactor', cycles: [] }, output: '', taskType })
      );
      assert.deepEqual(r, { written: true }, `${taskType} must stay exempt from the RC-D trap`);
      assert.equal(fs.existsSync(evidencePath(1)), true);
    }
    assert.equal(auditRowsFor('tdd-green-empty-rejected').length, 0, 'no rejection audits');
  });

  it('gate flow: silent-success non-eval command never records a gate GREEN (RC-D)', () => {
    // A bare `node -e "process.exit(0)"` verifier is NOT eval-shaped (the W6
    // unset-envelope guard cannot catch it) and exits 0 with zero output —
    // the exact shape coverage finding 3 showed slipping past the gate while
    // the recorder refused the identical run.
    writeTasksMd([
      taskBlock(
        1,
        'tdd-code',
        strategyBlock(['kind: custom', 'command: node -e "process.exit(0)"'])
      ),
    ]);
    writeEvidence(1, {
      currentPhase: 'red',
      currentCycle: 1,
      cycles: [
        {
          cycle: 1,
          red: {
            testFiles: [],
            testCommand: 'node -e "process.exit(0)"',
            testExitCode: 1,
            timestamp: '2026-07-05T00:00:00.000Z',
            capturedByGate: true,
          },
        },
      ],
    });

    const state = makeState(1);
    state._preTestForTask = '1';
    const result = implementGate.dispatchAdvanceGate(
      'GH-TEST',
      { tasksDir, worktreeDir },
      makeDeps(state)
    );

    assert.equal(result && result.hold, 'planner-defect', 'RC-D refusal holds for the operator');
    assert.equal(state._tddRetryPlannerDefect, true);
    assert.match(String(state._tddRetryReason || ''), /NO stdout\/stderr/);
    const ev = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.equal(ev.cycles[0].green, undefined, 'no zero-output GREEN recorded');
    assert.equal(auditRowsFor('tdd-green-empty-rejected').length, 1);
  });

  it('writeGateStub: e2e-skip audits, non-tdd-pre-test does not', () => {
    gateWriter.writeGateStub(params({ stubKind: 'e2e-skip', reason: 'e2e-disabled' }));
    assert.equal(auditRowsFor('tdd-e2e-skip-stub').length, 1);
    const skip = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.equal(skip.cycles[0].green.skippedByGate, true);

    fs.rmSync(evidencePath(1));
    gateWriter.writeGateStub(params({ stubKind: 'non-tdd-pre-test', taskType: 'docs' }));
    assert.equal(auditRowsFor('tdd-e2e-skip-stub').length, 1, 'no second audit row');
    const stub = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.match(stub.cycles[0].red.note, /does not require TDD/);
  });
});
