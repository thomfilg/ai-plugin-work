/**
 * inspect-per-task-reports.test.js
 *
 * GH-259 Task 7.1: Tests that inspect.js populates s.perTaskReports
 * when tasks.md and taskN/ directories exist in the ticket's tasksDir.
 *
 * Uses node:test + node:assert/strict with temp filesystem fixtures.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { inspect } = require('../engine/inspect');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-per-task-'));
}

/**
 * Build minimal deps for inspect(). All side-effecting ops are faked
 * to avoid real git/tmux calls.
 */
function makeDeps(tasksBase) {
  return {
    tp: { sanitizeTicketIdForPath: (id) => id },
    run: () => '',
    fileExists: (p) => fs.existsSync(p),
    readFile: (p) => fs.readFileSync(p, 'utf-8'),
    listFiles: (dir, pattern) => {
      try {
        return fs
          .readdirSync(dir)
          .filter((f) => pattern.test(f))
          .map((f) => path.join(dir, f));
      } catch {
        return [];
      }
    },
    loadWorkState: () => null,
    getCurrentStep: () => null,
    REQUIRED_REPORTS: [],
    WORKTREES_BASE: '/tmp/nonexistent-worktrees',
    TASKS_BASE: tasksBase,
    MAIN_WORKTREE_FOLDER: 'repo',
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('inspect: perTaskReports aggregation (GH-259 Task 7.1)', () => {
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

  it('populates s.perTaskReports when tasks.md and taskN/ dirs exist', () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    const ticketDir = path.join(tmp, 'GH-259');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, 'tasks.md'), '# Tasks\n## Task 1\n## Task 2\n');

    // Create task1 with check reports and tdd-phase.json
    const task1Dir = path.join(ticketDir, 'task1');
    fs.mkdirSync(task1Dir, { recursive: true });
    fs.writeFileSync(
      path.join(task1Dir, 'tdd-phase.json'),
      JSON.stringify({ cycles: [{ red: { ts: 1 }, green: { ts: 2 } }] })
    );
    fs.writeFileSync(path.join(task1Dir, 'code-review.check.md'), 'Status: APPROVED');

    // Create task2 with only tdd-phase.json
    const task2Dir = path.join(ticketDir, 'task2');
    fs.mkdirSync(task2Dir, { recursive: true });
    fs.writeFileSync(
      path.join(task2Dir, 'tdd-phase.json'),
      JSON.stringify({ cycles: [{ red: { ts: 1 } }] })
    );

    const deps = makeDeps(tmp);
    const s = inspect('GH-259', {}, null, deps);

    assert.ok(s.perTaskReports, 'perTaskReports should be defined');
    assert.ok(s.perTaskReports.task1, 'task1 entry should exist');
    assert.ok(s.perTaskReports.task2, 'task2 entry should exist');

    // task1 has tdd-phase.json and a check.md file
    assert.ok(s.perTaskReports.task1.tddPhase, 'task1 should have tddPhase');
    assert.ok(
      Array.isArray(s.perTaskReports.task1.checkReports),
      'task1 checkReports should be array'
    );
    assert.equal(s.perTaskReports.task1.checkReports.length, 1);

    // task2 has tdd-phase.json but no check.md files
    assert.ok(s.perTaskReports.task2.tddPhase, 'task2 should have tddPhase');
    assert.equal(s.perTaskReports.task2.checkReports.length, 0);
  });

  it('does NOT set s.perTaskReports when no tasks.md exists', () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    const ticketDir = path.join(tmp, 'GH-100');
    fs.mkdirSync(ticketDir, { recursive: true });

    const deps = makeDeps(tmp);
    const s = inspect('GH-100', {}, null, deps);

    assert.equal(
      s.perTaskReports,
      undefined,
      'perTaskReports should be undefined without tasks.md'
    );
  });

  it('handles tasks.md present but no taskN/ directories', () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    const ticketDir = path.join(tmp, 'GH-101');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, 'tasks.md'), '# Tasks\n## Task 1\n');

    const deps = makeDeps(tmp);
    const s = inspect('GH-101', {}, null, deps);

    assert.ok(s.perTaskReports, 'perTaskReports should still be defined');
    assert.deepStrictEqual(s.perTaskReports, {}, 'but should be empty object');
  });

  it('includes tddPhase status from tdd-phase.json content', () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    const ticketDir = path.join(tmp, 'GH-102');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, 'tasks.md'), '# Tasks\n## Task 1\n');

    const task1Dir = path.join(ticketDir, 'task1');
    fs.mkdirSync(task1Dir, { recursive: true });
    fs.writeFileSync(
      path.join(task1Dir, 'tdd-phase.json'),
      JSON.stringify({ exception: 'config-only', cycles: [] })
    );

    const deps = makeDeps(tmp);
    const s = inspect('GH-102', {}, null, deps);

    assert.ok(s.perTaskReports.task1.tddPhase, 'tddPhase should exist');
    assert.equal(
      s.perTaskReports.task1.tddPhase.exception,
      true,
      'exception mode should be flagged'
    );
  });

  it('shows exception: true for structured exception object in tdd-phase.json', () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    const ticketDir = path.join(tmp, 'GH-104');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, 'tasks.md'), '# Tasks\n## Task 1\n');

    const task1Dir = path.join(ticketDir, 'task1');
    fs.mkdirSync(task1Dir, { recursive: true });
    fs.writeFileSync(
      path.join(task1Dir, 'tdd-phase.json'),
      JSON.stringify({ exception: { category: 'config-only', reason: 'test' }, cycles: [] })
    );

    const deps = makeDeps(tmp);
    const s = inspect('GH-104', {}, null, deps);

    assert.ok(s.perTaskReports.task1.tddPhase, 'tddPhase should exist');
    assert.equal(
      s.perTaskReports.task1.tddPhase.exception,
      true,
      'structured exception object should be flagged as exception: true'
    );
  });

  it('preserves s.reports for backward compatibility', () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    const ticketDir = path.join(tmp, 'GH-103');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, 'tasks.md'), '# Tasks\n## Task 1\n');

    const deps = makeDeps(tmp);
    const s = inspect('GH-103', {}, null, deps);

    assert.ok(s.reports !== undefined, 's.reports should still exist');
    assert.equal(typeof s.reports, 'object');
  });
});
