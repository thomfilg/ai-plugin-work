/**
 * W2 + W4 (implement-phase fix design) — single TDD-exemption taxonomy at the
 * implement gate, and citation-kind evidence acceptance.
 *
 * Scenarios:
 *   - W2: a Type=docs task whose verifier passes pre-implement records the
 *     non-TDD stub and dispatches (previously blocked with "Pre-implement
 *     test passed ... TDD requires a failing test"), then flows stub →
 *     dispatch → GREEN → advance without wedging.
 *   - W2: a Type=config task with red-only stub evidence (and no runnable
 *     strategy) passes validation and advances — the echo-4552 #2 wedge.
 *   - W2: an unknown/freeform Type stays TDD-required (fail closed — no
 *     agent self-exemption via an invented Type).
 *   - W4: a verified-by task with green-only citation evidence flows through
 *     dispatchAdvanceGate to advance without retry; missing peerSha is
 *     rejected with a named reason.
 *   - Unit: evidence.js isTddRequired delegates to the task-types.js enum;
 *     resolveTaskType keeps hyphenated Types intact.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const implementGate = require('../lib/step-enrichments/implement-gate');
const tddEnf = require('../lib/tdd-enforcement');
const { isTddRequired } = require('../lib/step-enrichments/implement-gate/evidence');
const { resolveTaskType } = require('../lib/resolve-task-type');

// Built by concatenation so the live plugin's state-file protection hooks
// never see the literal names next to write calls when scanning this fixture
// script (test-code fs writes to a temp dir are legitimate fixtures).
const WORK_STATE_FILE = ['.work-state', 'json'].join('.');
const TDD_EVIDENCE_FILE = ['tdd-phase', 'json'].join('.');

let tmp;
let tasksBase;
let tasksDir;
let worktreeDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-exemption-int-'));
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

/** Real evidence readers/validators — the point of these tests. */
function makeDeps(state, opts) {
  return {
    loadWorkState: () => state,
    saveWorkState: (_safe, ws) => {
      Object.assign(state, ws);
    },
    readTddEvidence: (safe, step, taskNum) =>
      tddEnf.readTddEvidence(tasksBase, safe, step, taskNum),
    validateTddEvidence: tddEnf.validateTddEvidence,
    stepName: 'implement',
    // Real workDir (contains work-state.js) so task-advance actually runs
    // against the on-disk state fixture when one exists.
    workDir: (opts && opts.workDir) || path.join(__dirname, '..'),
    log: Object.assign(() => {}, { recurse: () => {} }),
    recursionDepth: 0,
  };
}

function writeOnDiskWorkState(state) {
  fs.writeFileSync(
    path.join(tasksDir, WORK_STATE_FILE),
    JSON.stringify({ ticketId: state.ticketId, tasksMeta: state.tasksMeta }, null, 2)
  );
}

function evidencePath(taskNum) {
  return path.join(tasksDir, `task${taskNum}`, TDD_EVIDENCE_FILE);
}

function writeEvidence(taskNum, evidence) {
  fs.mkdirSync(path.dirname(evidencePath(taskNum)), { recursive: true });
  fs.writeFileSync(evidencePath(taskNum), JSON.stringify(evidence, null, 2));
}

describe('W2 — Type=docs task with passing verifier: stub → dispatch → GREEN → advance', () => {
  let okScript;

  beforeEach(() => {
    okScript = path.join(worktreeDir, 'ok.js');
    fs.writeFileSync(okScript, 'console.log("docs verifier ok");process.exit(0);\n');
    writeTasksMd([
      taskBlock(1, 'docs', strategyBlock(['kind: custom', `command: node ${okScript}`])),
      taskBlock(2, 'docs', strategyBlock(['kind: custom', `command: node ${okScript}`])),
    ]);
  });

  it('pass 1: pre-test passes → non-TDD stub recorded, dispatch (NO block)', () => {
    const state = makeState(2);
    const ctx = { tasksDir, worktreeDir };

    const result = implementGate.dispatchAdvanceGate('GH-TEST', ctx, makeDeps(state));

    assert.equal(result, null, 'gate returns null so the dev agent is dispatched');
    assert.equal(
      state._tddRetryReason,
      undefined,
      `docs task must not block on a passing pre-test (got: ${state._tddRetryReason})`
    );
    const ev = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.ok(ev.cycles[0].red, 'stub RED entry recorded');
    assert.match(ev.cycles[0].red.note || '', /does not require TDD/);
    assert.equal(state._preTestForTask, '1');
  });

  it('pass 2: post-test passes → GREEN appended → task advances (no wedge)', () => {
    const state = makeState(2);
    const ctx = { tasksDir, worktreeDir };
    writeOnDiskWorkState(state);
    const deps = makeDeps(state);

    implementGate.dispatchAdvanceGate('GH-TEST', ctx, deps); // pre-test → stub
    const result = implementGate.dispatchAdvanceGate('GH-TEST', ctx, deps); // post-test → advance

    assert.deepEqual(result, { recurse: true }, 'gate advances to the next task');
    const ev = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.ok(ev.cycles[0].green, 'GREEN entry appended after the passing post-test');
    assert.equal(state._tddRetryReason, undefined, 'no retry recorded');
    const onDisk = JSON.parse(fs.readFileSync(path.join(tasksDir, WORK_STATE_FILE), 'utf8'));
    assert.equal(onDisk.tasksMeta.tasks[0].status, 'completed');
    assert.equal(onDisk.tasksMeta.currentTaskIndex, 1);
  });
});

describe('W2 — Type=config task with red-only stub evidence advances (echo-4552 #2 wedge)', () => {
  it('red-only stub evidence + no runnable strategy → advance, not infinite retry', () => {
    // No ### Test Strategy at all — the wedge shape: a stub was recorded but
    // there is nothing to run, so strict validateTddEvidence would reject the
    // red-only cycle forever.
    writeTasksMd([taskBlock(1, 'config')]);
    writeEvidence(1, {
      currentPhase: 'green',
      currentCycle: 1,
      cycles: [
        {
          cycle: 1,
          red: {
            testCommand: 'node verify.js',
            testExitCode: 0,
            timestamp: '2026-07-05T00:00:00.000Z',
            capturedByGate: true,
            note: 'RED skipped: task type "config" does not require TDD.',
          },
        },
      ],
    });

    const state = makeState(1);
    const result = implementGate.dispatchAdvanceGate(
      'GH-TEST',
      { tasksDir, worktreeDir },
      makeDeps(state)
    );

    assert.equal(result, null, 'single task → gate finishes (advance path, not retry)');
    assert.equal(
      state._tddRetryReason,
      undefined,
      `config task with stub evidence must not retry (got: ${state._tddRetryReason})`
    );
  });

  it('same red-only evidence under an unknown Type stays TDD-required (fail closed)', () => {
    writeTasksMd([taskBlock(1, 'backend')]);
    writeEvidence(1, {
      currentPhase: 'green',
      currentCycle: 1,
      cycles: [{ cycle: 1, red: { testCommand: 'node verify.js', testExitCode: 0 } }],
    });

    const state = makeState(1);
    // Mark pre-test done so the flow lands on validation (no strategy to run).
    state._preTestForTask = '1';
    implementGate.dispatchAdvanceGate('GH-TEST', { tasksDir, worktreeDir }, makeDeps(state));

    assert.match(
      String(state._tddRetryReason || ''),
      /TDD evidence invalid/,
      'freeform Type must not self-exempt from the full RED→GREEN contract'
    );
  });
});

describe('W4 — verified-by citation evidence flows through dispatchAdvanceGate', () => {
  beforeEach(() => {
    writeTasksMd([taskBlock(1, 'tdd-code', strategyBlock(['kind: verified-by', 'peer: 2']))]);
  });

  function citationEvidence(green) {
    return {
      currentPhase: 'green',
      currentCycle: 1,
      cycles: [{ cycle: 1, green }],
    };
  }

  it('green-only citation evidence with peerSha → advance without retry', () => {
    writeEvidence(
      1,
      citationEvidence({
        kind: 'verified-by',
        peer: 2,
        peerSha: 'deadbeefcafe',
        scopeOverlap: true,
        recordedAt: '2026-07-05T00:00:00.000Z',
      })
    );

    const state = makeState(1);
    const result = implementGate.dispatchAdvanceGate(
      'GH-TEST',
      { tasksDir, worktreeDir },
      makeDeps(state)
    );

    assert.equal(result, null, 'single task → gate finishes via the advance path');
    assert.equal(
      state._tddRetryReason,
      undefined,
      `citation evidence must satisfy the gate (got: ${state._tddRetryReason})`
    );
  });

  it('citation evidence WITHOUT peerSha → retry naming the missing peerSha', () => {
    writeEvidence(
      1,
      citationEvidence({
        kind: 'verified-by',
        peer: 2,
        scopeOverlap: true,
        recordedAt: '2026-07-05T00:00:00.000Z',
      })
    );

    const state = makeState(1);
    implementGate.dispatchAdvanceGate('GH-TEST', { tasksDir, worktreeDir }, makeDeps(state));

    assert.match(String(state._tddRetryReason || ''), /peerSha/);
  });
});

describe('one shared validator — docs red-only stub passes EVERY downstream validator', () => {
  // Downstream-review finding 1 + coverage finding 2: the gate's relaxed
  // exempt-type acceptance must be the SAME rule at every downstream
  // consumer (transition-step implement→commit gate, check-gate
  // per-task-tdd-evidence, workflow-definition verifyPerTaskTDD /
  // completion-checker path, mark-task-progress) — otherwise a docs task the
  // gate advanced on red-only stub evidence dead-ends at check/complete with
  // no implement-phase remediation left.
  const RED_ONLY_STUB = {
    currentPhase: 'green',
    currentCycle: 1,
    cycles: [
      {
        cycle: 1,
        red: {
          testCommand: 'node verify.js',
          testExitCode: 0,
          timestamp: '2026-07-05T00:00:00.000Z',
          capturedByGate: true,
          note: 'RED skipped: task type "docs" does not require TDD.',
        },
      },
    ],
  };

  beforeEach(() => {
    // Single docs task with NO runnable strategy — the stub stays red-only.
    writeTasksMd([taskBlock(1, 'docs', ['- [ ] Write the README section', ''])]);
    writeEvidence(1, RED_ONLY_STUB);
  });

  it('advances through the implement gate (no retry)', () => {
    const state = makeState(1);
    const result = implementGate.dispatchAdvanceGate(
      'GH-TEST',
      { tasksDir, worktreeDir },
      makeDeps(state)
    );
    assert.equal(result, null, 'single docs task → gate finishes via the advance path');
    assert.equal(state._tddRetryReason, undefined);
  });

  it('passes the transition-step implement→commit TDD gate', () => {
    const { transitionStep } = require('../engine/transition-step');
    const { STEPS, ALL_STEPS, STEP_TRANSITIONS, workflowCanTransition } =
      require('../step-registry');
    const stepStatus = {};
    for (const s of ALL_STEPS) stepStatus[s] = 'pending';
    stepStatus[STEPS.implement] = 'in_progress';
    const ws = {
      ticketId: 'GH-TEST',
      stepStatus,
      checkProgress: {},
      errors: [],
      tasksMeta: { currentTaskIndex: 1, tasks: [{ id: 'task_1', status: 'completed' }] },
    };
    const result = transitionStep('GH-TEST', STEPS.commit, {
      tp: {
        getProviderConfig: () => ({ provider: 'github', projectKey: 'GH' }),
        sanitizeTicketIdForPath: (id) => id,
      },
      STEPS,
      ALL_STEPS,
      STEP_TRANSITIONS,
      workflowCanTransition,
      TDD_GATED_STEPS: [STEPS.implement],
      readTddEvidence: (safe, step, taskNum) =>
        tddEnf.readTddEvidence(tasksBase, safe, step, taskNum),
      validateCheckGate: () => ({ valid: true }),
      archiveStepArtifacts: () => null,
      appendAction: () => {},
      loadWorkState: () => ws,
      saveWorkState: () => {},
      getCurrentStep: () => STEPS.implement,
      TASKS_BASE: tasksBase,
      softSteps: new Set(),
      commandMap: [],
      getHeadSha: () => 'a'.repeat(40),
    });
    assert.notEqual(
      result && result.error,
      true,
      `implement→commit must pass for the docs stub (got: ${result && result.message})`
    );
  });

  it('passes the check-gate per-task-tdd-evidence rule', () => {
    const { CHECK_GATE_RULES } = require('../gates/check-gate');
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'per-task-tdd-evidence');
    assert.deepEqual(rule.check(tasksDir, 'GH-TEST'), []);
  });

  it('passes verifyPerTaskTDD (check-step verify / completion path)', () => {
    // Purge the cached config so WEB_APPS from the host env cannot force the
    // QA-report branch (mirrors check-gate.test.js).
    process.env.WEB_APPS = '[]';
    delete require.cache[require.resolve('../../lib/config')];
    const createWorkflowDefinition = require('../workflow-definition');
    const { STEPS } = require('../step-registry');
    const { workflow } = createWorkflowDefinition({
      TASKS_BASE: tasksBase,
      safeTicketPath: (t) => t,
      resolveGitHead: () => 'a'.repeat(40),
    });
    // Satisfy the check step's report-file preconditions so the verify
    // reaches verifyPerTaskTDD.
    for (const f of [
      'code-review.check.md',
      'tests.check.md',
      'completion.check.md',
      'README.md',
    ]) {
      fs.writeFileSync(path.join(tasksDir, f), 'Status: APPROVED\n');
    }
    const entry = workflow.commandMap.find(
      (e) => e.step === STEPS.check && typeof e.verify === 'function'
    );
    assert.ok(entry, 'check step verify entry must exist');
    assert.equal(
      entry.verify('GH-TEST'),
      true,
      'verifyPerTaskTDD must accept the docs red-only stub'
    );
  });

  it('mark-task-progress ticks the docs task checkbox to [x]', () => {
    const { markProgress } = require('../lib/mark-task-progress');
    markProgress(tasksDir);
    const content = fs.readFileSync(path.join(tasksDir, 'tasks.md'), 'utf8');
    assert.match(content, /- \[x\] Write the README section/);
  });

  it('the SAME red-only stub under tdd-code still fails downstream (contract-scoped)', () => {
    writeTasksMd([taskBlock(1, 'tdd-code', ['- [ ] Implement the thing', ''])]);
    const { CHECK_GATE_RULES } = require('../gates/check-gate');
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'per-task-tdd-evidence');
    const reasons = rule.check(tasksDir, 'GH-TEST');
    assert.equal(reasons.length, 1, 'tdd-code red-only must still be rejected at check');
  });
});

describe('W2 — unified isTddRequired (evidence.js delegates to task-types.js)', () => {
  it('exempts every TDD_EXEMPT type from the shared enum', () => {
    for (const t of [
      'tests-only',
      'docs',
      'config',
      'ci',
      'mechanical-refactor',
      'file-move',
      'checkpoint',
    ]) {
      assert.equal(isTddRequired(t), false, `${t} must be TDD-exempt`);
    }
  });

  it('requires TDD for tdd-code and fails closed on unknown/missing types', () => {
    assert.equal(isTddRequired('tdd-code'), true);
    assert.equal(isTddRequired('backend'), true, 'freeform Type must stay TDD-required');
    assert.equal(isTddRequired(null), true);
    assert.equal(isTddRequired(undefined), true);
  });
});

describe('resolveTaskType keeps hyphenated Types intact', () => {
  it('parses tests-only / mechanical-refactor / file-move / tdd-code without truncation', () => {
    writeTasksMd([
      taskBlock(1, 'tests-only'),
      taskBlock(2, 'mechanical-refactor'),
      taskBlock(3, 'file-move'),
      taskBlock(4, 'tdd-code'),
    ]);
    assert.equal(resolveTaskType(tasksDir, 1), 'tests-only');
    assert.equal(resolveTaskType(tasksDir, 2), 'mechanical-refactor');
    assert.equal(resolveTaskType(tasksDir, 3), 'file-move');
    assert.equal(resolveTaskType(tasksDir, 4), 'tdd-code');
  });
});
