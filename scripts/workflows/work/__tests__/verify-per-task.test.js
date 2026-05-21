/**
 * verify-per-task.test.js
 *
 * GH-259 Task 7.2: Tests that workflow-definition.js verify functions
 * for `check` and `reports` steps account for per-task directories
 * when tasks.md exists.
 *
 * Uses node:test + node:assert/strict with temp filesystem fixtures.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const createWorkflowDefinition = require(path.join(__dirname, '..', 'workflow-definition'));
const { STEPS } = require(path.join(__dirname, '..', 'step-registry'));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verify-per-task-'));
}

function makeDeps(tasksBase) {
  return {
    TASKS_BASE: tasksBase,
    safeTicketPath: (id) => id,
    resolveGitHead: () => 'ref: refs/heads/stub',
  };
}

function getVerify(workflow, stepId) {
  const entries = workflow.commandMap.filter(
    (e) => e.step === stepId && typeof e.verify === 'function'
  );
  return entries.length > 0 ? entries[0].verify : undefined;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('workflow-definition: check verify with per-task TDD (GH-259 Task 7.2)', () => {
  const tmpDirs = [];
  after(() => {
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('check verify passes when tasks.md exists and all taskN/ have valid tdd-phase.json', () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    const ticketId = 'GH-259';
    const dir = path.join(tmp, ticketId);
    fs.mkdirSync(dir, { recursive: true });

    // Required check report files at ticket root
    fs.writeFileSync(path.join(dir, 'code-review.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'tests.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'completion.check.md'), 'Status: COMPLETE');
    fs.writeFileSync(path.join(dir, 'README.md'), '# README');
    fs.writeFileSync(path.join(dir, 'qa-feature.check.md'), 'Status: APPROVED');

    // tasks.md and per-task TDD evidence
    fs.writeFileSync(path.join(dir, 'tasks.md'), '# Tasks\n## Task 1\n## Task 2\n');
    const task1 = path.join(dir, 'task1');
    const task2 = path.join(dir, 'task2');
    fs.mkdirSync(task1, { recursive: true });
    fs.mkdirSync(task2, { recursive: true });
    fs.writeFileSync(
      path.join(task1, 'tdd-phase.json'),
      JSON.stringify({ cycles: [{ red: { ts: 1 }, green: { ts: 2 } }] })
    );
    fs.writeFileSync(
      path.join(task2, 'tdd-phase.json'),
      JSON.stringify({ cycles: [{ red: { ts: 1 }, green: { ts: 2 } }] })
    );

    const { workflow } = createWorkflowDefinition(makeDeps(tmp));
    const verify = getVerify(workflow, STEPS.check);
    assert.equal(verify(ticketId), true);
  });

  it('check verify fails when tasks.md exists and a taskN/ lacks tdd-phase.json', () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    const ticketId = 'GH-260';
    const dir = path.join(tmp, ticketId);
    fs.mkdirSync(dir, { recursive: true });

    // Required files at ticket root
    fs.writeFileSync(path.join(dir, 'code-review.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'tests.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'completion.check.md'), 'Status: COMPLETE');
    fs.writeFileSync(path.join(dir, 'README.md'), '# README');
    fs.writeFileSync(path.join(dir, 'qa-feature.check.md'), 'Status: APPROVED');

    // tasks.md with task dirs but task2 missing tdd-phase.json
    fs.writeFileSync(path.join(dir, 'tasks.md'), '# Tasks\n## Task 1\n## Task 2\n');
    const task1 = path.join(dir, 'task1');
    const task2 = path.join(dir, 'task2');
    fs.mkdirSync(task1, { recursive: true });
    fs.mkdirSync(task2, { recursive: true });
    fs.writeFileSync(
      path.join(task1, 'tdd-phase.json'),
      JSON.stringify({ cycles: [{ red: { ts: 1 }, green: { ts: 2 } }] })
    );

    const { workflow } = createWorkflowDefinition(makeDeps(tmp));
    const verify = getVerify(workflow, STEPS.check);
    assert.equal(verify(ticketId), false);
  });

  it('check verify still passes in single-task mode (no tasks.md)', () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    const ticketId = 'GH-261';
    const dir = path.join(tmp, ticketId);
    fs.mkdirSync(dir, { recursive: true });

    // Required check files only
    fs.writeFileSync(path.join(dir, 'code-review.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'tests.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'completion.check.md'), 'Status: COMPLETE');
    fs.writeFileSync(path.join(dir, 'README.md'), '# README');
    fs.writeFileSync(path.join(dir, 'qa-feature.check.md'), 'Status: APPROVED');

    const { workflow } = createWorkflowDefinition(makeDeps(tmp));
    const verify = getVerify(workflow, STEPS.check);
    assert.equal(verify(ticketId), true);
  });

  it('check verify fails when tasks.md declares 3 tasks but only 2 dirs exist', () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    const ticketId = 'GH-280';
    const dir = path.join(tmp, ticketId);
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(path.join(dir, 'code-review.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'tests.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'completion.check.md'), 'Status: COMPLETE');
    fs.writeFileSync(path.join(dir, 'README.md'), '# README');
    fs.writeFileSync(path.join(dir, 'qa-feature.check.md'), 'Status: APPROVED');

    fs.writeFileSync(path.join(dir, 'tasks.md'), '# Tasks\n## Task 1\n## Task 2\n## Task 3\n');
    const task1 = path.join(dir, 'task1');
    const task2 = path.join(dir, 'task2');
    fs.mkdirSync(task1, { recursive: true });
    fs.mkdirSync(task2, { recursive: true });
    fs.writeFileSync(
      path.join(task1, 'tdd-phase.json'),
      JSON.stringify({ cycles: [{ red: { ts: 1 }, green: { ts: 2 } }] })
    );
    fs.writeFileSync(
      path.join(task2, 'tdd-phase.json'),
      JSON.stringify({ cycles: [{ red: { ts: 1 }, green: { ts: 2 } }] })
    );
    // task3 dir does not exist — gate must catch this

    const { workflow } = createWorkflowDefinition(makeDeps(tmp));
    const verify = getVerify(workflow, STEPS.check);
    assert.equal(verify(ticketId), false);
  });

  it('check verify skips checkpoint tasks from tasks.md', () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    const ticketId = 'GH-281';
    const dir = path.join(tmp, ticketId);
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(path.join(dir, 'code-review.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'tests.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'completion.check.md'), 'Status: COMPLETE');
    fs.writeFileSync(path.join(dir, 'README.md'), '# README');
    fs.writeFileSync(path.join(dir, 'qa-feature.check.md'), 'Status: APPROVED');

    fs.writeFileSync(
      path.join(dir, 'tasks.md'),
      '# Tasks\n## Task 1\n— Implement feature\n### Type\nimplementation\n\n## Task 2\n— Checkpoint\n### Type\ncheckpoint\n'
    );
    const task1 = path.join(dir, 'task1');
    fs.mkdirSync(task1, { recursive: true });
    fs.writeFileSync(
      path.join(task1, 'tdd-phase.json'),
      JSON.stringify({ cycles: [{ red: { ts: 1 }, green: { ts: 2 } }] })
    );
    // task2 is checkpoint — no dir needed

    const { workflow } = createWorkflowDefinition(makeDeps(tmp));
    const verify = getVerify(workflow, STEPS.check);
    assert.equal(verify(ticketId), true);
  });

  it('check verify passes when taskN/ has exception mode in tdd-phase.json', () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    const ticketId = 'GH-262';
    const dir = path.join(tmp, ticketId);
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(path.join(dir, 'code-review.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'tests.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'completion.check.md'), 'Status: COMPLETE');
    fs.writeFileSync(path.join(dir, 'README.md'), '# README');
    fs.writeFileSync(path.join(dir, 'qa-feature.check.md'), 'Status: APPROVED');

    fs.writeFileSync(path.join(dir, 'tasks.md'), '# Tasks\n## Task 1\n');
    const task1 = path.join(dir, 'task1');
    fs.mkdirSync(task1, { recursive: true });
    fs.writeFileSync(
      path.join(task1, 'tdd-phase.json'),
      JSON.stringify({ exception: 'config-only', cycles: [] })
    );

    const { workflow } = createWorkflowDefinition(makeDeps(tmp));
    const verify = getVerify(workflow, STEPS.check);
    assert.equal(verify(ticketId), true);
  });
});

describe('workflow-definition: reports verify with per-task dirs (GH-259 Task 7.2)', () => {
  const tmpDirs = [];
  after(() => {
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('reports verify passes when tasks.md exists and all taskN/ have valid tdd-phase.json', () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    const ticketId = 'GH-270';
    const dir = path.join(tmp, ticketId);
    fs.mkdirSync(dir, { recursive: true });

    // Required approved files at ticket root
    fs.writeFileSync(path.join(dir, 'code-review.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'tests.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'completion.check.md'), 'Status: COMPLETE');
    fs.writeFileSync(path.join(dir, 'qa-feature.check.md'), 'Status: APPROVED');

    // tasks.md with per-task evidence
    fs.writeFileSync(path.join(dir, 'tasks.md'), '# Tasks\n## Task 1\n');
    const task1 = path.join(dir, 'task1');
    fs.mkdirSync(task1, { recursive: true });
    fs.writeFileSync(
      path.join(task1, 'tdd-phase.json'),
      JSON.stringify({ cycles: [{ red: { ts: 1 }, green: { ts: 2 } }] })
    );

    const { workflow } = createWorkflowDefinition(makeDeps(tmp));
    const verify = getVerify(workflow, STEPS.reports);
    assert.equal(verify(ticketId), true);
  });

  it('reports verify fails when tasks.md exists and a taskN/ lacks valid tdd evidence', () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    const ticketId = 'GH-271';
    const dir = path.join(tmp, ticketId);
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(path.join(dir, 'code-review.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'tests.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'completion.check.md'), 'Status: COMPLETE');
    fs.writeFileSync(path.join(dir, 'qa-feature.check.md'), 'Status: APPROVED');

    fs.writeFileSync(path.join(dir, 'tasks.md'), '# Tasks\n## Task 1\n');
    const task1 = path.join(dir, 'task1');
    fs.mkdirSync(task1, { recursive: true });
    // no tdd-phase.json in task1

    const { workflow } = createWorkflowDefinition(makeDeps(tmp));
    const verify = getVerify(workflow, STEPS.reports);
    assert.equal(verify(ticketId), false);
  });

  it('reports verify passes in single-task mode (no tasks.md)', () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    const ticketId = 'GH-272';
    const dir = path.join(tmp, ticketId);
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(path.join(dir, 'code-review.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'tests.check.md'), 'Status: APPROVED');
    fs.writeFileSync(path.join(dir, 'completion.check.md'), 'Status: COMPLETE');
    fs.writeFileSync(path.join(dir, 'qa-feature.check.md'), 'Status: APPROVED');

    const { workflow } = createWorkflowDefinition(makeDeps(tmp));
    const verify = getVerify(workflow, STEPS.reports);
    assert.equal(verify(ticketId), true);
  });
});
