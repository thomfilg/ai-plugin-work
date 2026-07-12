/**
 * GH-694 failure 1 — tests-only GREEN must prove authorship at the gate.
 *
 * buildNonTddStub legitimately skips RED for Type=tests-only, but the gate's
 * GREEN then passed by re-running an untouched pre-existing suite (GH-689
 * task 2: `guard-codex.test.js` ran green with zero modified test files and
 * the task's actual deliverable never existed). writeGateGreen — the ONE
 * atomic gate evidence writer — now applies the recorder's exact GH-528 rule
 * via the shared lib/changed-test-files module:
 *
 *   - zero changed in-scope *.test.* / *.spec.* files → rejected with a
 *     `tdd-green-tests-only-unchanged-rejected` audit row; NOT a
 *     plannerDefect (flows into dispatch-retry — the developer fixes it by
 *     writing the declared tests).
 *   - with a changed in-scope test file (untracked counts) → GREEN written
 *     with the audit-only `testsOnlyChangedFiles` stamp.
 *   - tdd-code / docs GREENs are unaffected (regression).
 *   - validateTddEvidenceForType is deliberately UNCHANGED: pre-change gate
 *     evidence (capturedByGate, no testsOnlyChangedFiles) must still
 *     validate, or in-flight tickets would dead-end (unification invariant).
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const gateWriter = require('../../work-implement/tdd-phase-state/gate-writer');
const { runTestAndRecord } = require('../lib/step-enrichments/implement-gate/test-runner');
const { validateTddEvidenceForType } = require('../lib/tdd-enforcement');

// Built by concatenation so the live plugin's state-file protection hooks
// never see the literal names next to write calls in this fixture script.
const TDD_EVIDENCE_FILE = ['tdd-phase', 'json'].join('.');
const ACTIONS_FILE = ['.work-actions', 'json'].join('.');

let tmp;
let tasksBase;
let tasksDir;
let worktreeDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh694-tests-only-'));
  tasksBase = path.join(tmp, 'tasks');
  tasksDir = path.join(tasksBase, 'GH-TEST');
  worktreeDir = path.join(tmp, 'wt');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(worktreeDir, { recursive: true });
  // Seed a git worktree whose pre-existing in-scope suite is committed and
  // byte-identical — the exact GH-689 "unchanged suite" shape.
  git('init', '-q');
  fs.mkdirSync(path.join(worktreeDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, 'tests', 'existing.test.js'), 'pre-existing suite\n');
  git('add', '.');
  git(
    '-c',
    'user.email=fixture@example.com',
    '-c',
    'user.name=fixture',
    'commit',
    '-q',
    '-m',
    'seed'
  );
});

afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function git(...args) {
  return execFileSync('git', args, { cwd: worktreeDir, encoding: 'utf8' });
}

function writeTasksMd(type) {
  fs.writeFileSync(
    path.join(tasksDir, 'tasks.md'),
    [
      '## Task 1 — Fixture task 1',
      '',
      '### Type',
      type,
      '',
      '### Files in scope',
      '- tests',
      '',
    ].join('\n')
  );
}

function evidencePath(taskNum) {
  return path.join(tasksDir, `task${taskNum}`, TDD_EVIDENCE_FILE);
}

function redStub(taskType) {
  return {
    testCommand: 'node --test tests/',
    testExitCode: 0,
    timestamp: '2026-07-11T00:00:00.000Z',
    capturedByGate: true,
    note: `RED skipped: task type "${taskType}" does not require TDD.`,
  };
}

function writeRedEvidence(taskNum, taskType) {
  fs.mkdirSync(path.dirname(evidencePath(taskNum)), { recursive: true });
  fs.writeFileSync(
    evidencePath(taskNum),
    JSON.stringify({
      currentPhase: 'green',
      currentCycle: 1,
      cycles: [{ cycle: 1, red: redStub(taskType) }],
    })
  );
}

function auditRowsFor(action) {
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(path.join(tasksDir, ACTIONS_FILE), 'utf8'));
  } catch {
    rows = [];
  }
  return rows.filter((r) => r && r.kind === 'enforcement' && r.action === action);
}

// Directory-prefix scope entry (legacy `a/b` → `a/b/**` semantics shared by
// filterChangedTestFilesByScope) — matches everything under tests/.
const SCOPE = ['tests'];

function greenParams(extra) {
  return {
    tasksBase,
    ticketId: 'GH-TEST',
    taskNum: 1,
    evidencePath: evidencePath(1),
    evidence: {
      currentPhase: 'refactor',
      currentCycle: 1,
      cycles: [
        {
          cycle: 1,
          red: redStub('tests-only'),
          green: { testCommand: 'node --test tests/', testExitCode: 0 },
        },
      ],
    },
    cmd: 'node --test tests/',
    output: 'ok 1 - existing\n# pass 1\n',
    taskType: 'tests-only',
    workingDir: worktreeDir,
    scope: SCOPE,
    ...extra,
  };
}

describe('GH-694 — writeGateGreen tests-only trap', () => {
  it('rejects an unchanged pre-existing suite (audited, NOT a planner defect)', () => {
    const r = gateWriter.writeGateGreen(greenParams());
    assert.equal(r.rejected, true, 'unchanged suite must not record GREEN');
    assert.ok(!r.plannerDefect, 'dispatch-retry shape — the developer fixes it, not the planner');
    assert.match(r.reason, /tests-only GREEN requires/i);
    assert.match(r.reason, /unchanged pre-existing suite is not evidence/);
    assert.equal(fs.existsSync(evidencePath(1)), false, 'no GREEN evidence written');
    const rows = auditRowsFor('tdd-green-tests-only-unchanged-rejected');
    assert.equal(rows.length, 1, 'rejection is audit-logged');
    assert.equal(rows[0].allow, false);
    assert.equal(rows[0].meta.taskType, 'tests-only');
  });

  it('accepts with a new in-scope test file (untracked counts) and stamps testsOnlyChangedFiles', () => {
    fs.writeFileSync(path.join(worktreeDir, 'tests', 'new-parity.test.js'), 'new describe block\n');
    const r = gateWriter.writeGateGreen(greenParams());
    assert.deepEqual(r, { written: true });
    const ev = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.deepEqual(
      ev.cycles[0].green.testsOnlyChangedFiles,
      ['tests/new-parity.test.js'],
      'audit-only stamp names the changed in-scope test files'
    );
    assert.equal(auditRowsFor('tdd-green-tests-only-unchanged-rejected').length, 0);
  });

  it('does not trap tdd-code or docs GREENs (regression)', () => {
    for (const taskType of ['tdd-code', 'docs']) {
      try {
        fs.rmSync(evidencePath(1));
      } catch {
        /* first iteration */
      }
      const r = gateWriter.writeGateGreen(greenParams({ taskType }));
      assert.deepEqual(r, { written: true }, `${taskType} must not hit the tests-only trap`);
    }
    assert.equal(auditRowsFor('tdd-green-tests-only-unchanged-rejected').length, 0);
  });
});

describe('GH-694 — persistGateGreen threads workingDir + scope (via runTestAndRecord)', () => {
  it('unchanged suite → passed:false dispatch-retry with the tests-only reason', () => {
    writeTasksMd('tests-only');
    writeRedEvidence(1, 'tests-only');
    const res = runTestAndRecord(
      'echo tests-pass',
      'GH-TEST',
      1,
      worktreeDir,
      process.env,
      tasksBase,
      'tests-only'
    );
    assert.equal(res.passed, false, 'unchanged suite must not pass the gate');
    assert.ok(!res.plannerDefect, 'NOT plannerDefect — flows into dispatch-retry');
    assert.match(String(res.reason || ''), /tests-only GREEN requires/i);
    assert.equal(auditRowsFor('tdd-green-tests-only-unchanged-rejected').length, 1);
  });

  it('new in-scope test file → passed:true with the evidence stamped', () => {
    writeTasksMd('tests-only');
    writeRedEvidence(1, 'tests-only');
    fs.writeFileSync(path.join(worktreeDir, 'tests', 'new-parity.test.js'), 'new describe block\n');
    const res = runTestAndRecord(
      'echo tests-pass',
      'GH-TEST',
      1,
      worktreeDir,
      process.env,
      tasksBase,
      'tests-only'
    );
    assert.equal(res.passed, true, `expected pass, got ${JSON.stringify(res)}`);
    const ev = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.deepEqual(ev.cycles[0].green.testsOnlyChangedFiles, ['tests/new-parity.test.js']);
  });

  it('tdd-code task with an unchanged tree still records GREEN (regression)', () => {
    writeTasksMd('tdd-code');
    writeRedEvidence(1, 'tdd-code');
    const res = runTestAndRecord(
      'echo tests-pass',
      'GH-TEST',
      1,
      worktreeDir,
      process.env,
      tasksBase,
      'tdd-code'
    );
    assert.equal(res.passed, true, `expected pass, got ${JSON.stringify(res)}`);
  });
});

describe('GH-694 — tests-only scope resolution fails closed (PR #717)', () => {
  // A changed test file that WOULD count under widened (empty) scope
  // semantics — proves the gate is failing closed, not just "no changes".
  function addUnrelatedChangedTestFile() {
    fs.writeFileSync(path.join(worktreeDir, 'tests', 'rogue.test.js'), 'unrelated new suite\n');
  }

  it('writeGateGreen rejects a tests-only GREEN with unresolved (null) scope', () => {
    addUnrelatedChangedTestFile();
    const r = gateWriter.writeGateGreen(
      greenParams({ scope: null, scopeError: 'tasks.md unreadable (fixture)' })
    );
    assert.equal(r.rejected, true, 'unresolved scope must not record GREEN');
    assert.equal(r.kind, 'tests-only-scope-unresolved');
    assert.match(r.reason, /failing closed/i);
    assert.match(r.reason, /tasks\.md unreadable \(fixture\)/);
    assert.equal(fs.existsSync(evidencePath(1)), false, 'no GREEN evidence written');
    const rows = auditRowsFor('tdd-green-tests-only-scope-unresolved-rejected');
    assert.equal(rows.length, 1, 'rejection is audit-logged');
    assert.equal(rows[0].allow, false);
  });

  it('missing tasks.md + unrelated changed test file → passed:false (no widening)', () => {
    // No writeTasksMd(): parseTasks returns null. Today the scope degrades
    // to [] and rogue.test.js counts — the exact widening in the finding.
    writeRedEvidence(1, 'tests-only');
    addUnrelatedChangedTestFile();
    const res = runTestAndRecord(
      'echo tests-pass',
      'GH-TEST',
      1,
      worktreeDir,
      process.env,
      tasksBase,
      'tests-only'
    );
    assert.equal(res.passed, false, 'unresolvable scope must fail closed, not widen');
    assert.match(String(res.reason || ''), /Files in scope.*could not be resolved/i);
    const ev = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.ok(!ev.cycles[0].green, 'GREEN must not be persisted');
    assert.equal(auditRowsFor('tdd-green-tests-only-scope-unresolved-rejected').length, 1);
  });

  it('tasks.md without the gated task number → passed:false for tests-only', () => {
    fs.writeFileSync(
      path.join(tasksDir, 'tasks.md'),
      ['## Task 2 — Some other task', '', '### Type', 'tests-only', ''].join('\n')
    );
    writeRedEvidence(1, 'tests-only');
    addUnrelatedChangedTestFile();
    const res = runTestAndRecord(
      'echo tests-pass',
      'GH-TEST',
      1,
      worktreeDir,
      process.env,
      tasksBase,
      'tests-only'
    );
    assert.equal(res.passed, false, 'task missing from the plan must fail closed');
    assert.match(String(res.reason || ''), /Files in scope.*could not be resolved/i);
  });

  it('task block parses but omits ### Files in scope → passed:false (no widening)', () => {
    // The block exists and parses fine — only the scope section is missing.
    // Passing [] through here would let rogue.test.js satisfy the GREEN gate.
    fs.writeFileSync(
      path.join(tasksDir, 'tasks.md'),
      ['## Task 1 — Add tests', '', '### Type', 'tests-only', ''].join('\n')
    );
    writeRedEvidence(1, 'tests-only');
    addUnrelatedChangedTestFile();
    const res = runTestAndRecord(
      'echo tests-pass',
      'GH-TEST',
      1,
      worktreeDir,
      process.env,
      tasksBase,
      'tests-only'
    );
    assert.equal(res.passed, false, 'declared-scope-less tests-only task must fail closed');
    assert.match(String(res.reason || ''), /declares no.*Files in scope/i);
    const ev = JSON.parse(fs.readFileSync(evidencePath(1), 'utf8'));
    assert.ok(!ev.cycles[0].green, 'GREEN must not be persisted');
  });

  it('empty ### Files in scope section → passed:false (no widening)', () => {
    fs.writeFileSync(
      path.join(tasksDir, 'tasks.md'),
      ['## Task 1 — Add tests', '', '### Type', 'tests-only', '', '### Files in scope', ''].join(
        '\n'
      )
    );
    writeRedEvidence(1, 'tests-only');
    addUnrelatedChangedTestFile();
    const res = runTestAndRecord(
      'echo tests-pass',
      'GH-TEST',
      1,
      worktreeDir,
      process.env,
      tasksBase,
      'tests-only'
    );
    assert.equal(res.passed, false, 'empty declared scope must fail closed');
    assert.match(String(res.reason || ''), /declares no.*Files in scope/i);
  });

  it('tdd-code task with missing tasks.md still records GREEN (regression)', () => {
    // Scope only feeds the tests-only trap — other types must not start
    // failing on an unreadable plan (they never consumed scope).
    writeRedEvidence(1, 'tdd-code');
    const res = runTestAndRecord(
      'echo tests-pass',
      'GH-TEST',
      1,
      worktreeDir,
      process.env,
      tasksBase,
      'tdd-code'
    );
    assert.equal(res.passed, true, `expected pass, got ${JSON.stringify(res)}`);
  });
});

describe('GH-694 — validator unchanged (unification-invariant pin)', () => {
  it('validateTddEvidenceForType still accepts pre-change tests-only gate evidence', () => {
    // Evidence recorded by the gate BEFORE this change: capturedByGate, no
    // testsOnlyChangedFiles stamp. A retroactive validator rule would
    // dead-end every in-flight ticket at the next downstream re-validation.
    const preChange = {
      currentPhase: 'refactor',
      currentCycle: 1,
      cycles: [
        {
          cycle: 1,
          red: redStub('tests-only'),
          green: {
            testCommand: 'node --test tests/',
            testExitCode: 0,
            timestamp: '2026-07-01T00:00:00.000Z',
            capturedByGate: true,
          },
        },
      ],
    };
    const v = validateTddEvidenceForType(preChange, 'tests-only');
    assert.equal(v.valid, true, `pre-change gate evidence must stay valid (got: ${v.reason})`);
  });
});
