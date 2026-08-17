/**
 * check-setup-tasks-base.test.js
 *
 * `/check` used to resolve its report folder from the worktree layout —
 * `path.join(getMainWorktreePath(), '..', 'tasks', taskId)` — and never
 * consulted TASKS_BASE. With the usual layout
 *
 *   WORKTREES_BASE=<root>/worktrees      (main worktree: <root>/worktrees/<repo>)
 *   TASKS_BASE=<root>/tasks
 *
 * that lands on `<root>/worktrees/tasks/<id>`, a SIBLING of the worktrees dir,
 * while check-next.js writes `.check-state.json` to `<TASKS_BASE>/<id>`. One
 * half of /check wrote reports where the other half never looked, and the gates
 * reported "Missing report: tests.check.md" for files one directory over.
 *
 * These tests drive the real hook as a subprocess against a real git worktree
 * layout, because the defect is in what the process computes, not in a helper.
 *
 * Uses node:test + node:assert/strict.
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHECK_SETUP = path.join(__dirname, '..', 'hooks', 'check-setup.js');
const TICKET = 'ECHO-6842';

let root;
let worktreesBase;
let tasksBase;
let mainRepo;
let ticketWorktree;

/** Run check-setup.js from `cwd` and return its parsed JSON, or the error. */
function runSetup({ cwd, env = {}, ticket = TICKET } = {}) {
  const childEnv = {
    ...process.env,
    WORKTREES_BASE: worktreesBase,
    TASKS_BASE: tasksBase,
    TICKET_PROVIDER: 'github',
    ...env,
  };
  for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
  try {
    const out = execFileSync(process.execPath, [CHECK_SETUP, ticket], {
      cwd,
      encoding: 'utf8',
      timeout: 20000,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, result: JSON.parse(out) };
  } catch (e) {
    let parsed = null;
    try {
      parsed = JSON.parse(String(e.stdout || ''));
    } catch {
      /* not JSON */
    }
    return { ok: false, result: parsed, status: e.status, stderr: String(e.stderr || '') };
  }
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-tasks-base-'));
  worktreesBase = path.join(root, 'worktrees');
  tasksBase = path.join(root, 'tasks');
  mainRepo = path.join(worktreesBase, 'my-repo');
  ticketWorktree = path.join(worktreesBase, `my-repo-${TICKET}`);

  fs.mkdirSync(mainRepo, { recursive: true });
  fs.mkdirSync(tasksBase, { recursive: true });

  const git = (cmd, cwd = mainRepo) => execSync(cmd, { cwd, stdio: 'ignore' });
  git('git init -b main');
  git('git config user.email "test@test.com"');
  git('git config user.name "Test"');
  fs.writeFileSync(path.join(mainRepo, 'file.txt'), 'base\n');
  git('git add -A');
  git('git commit -m init');
  // A ticket worktree, exactly the shape /check runs in.
  git(`git worktree add -b feature/${TICKET}-fix "${ticketWorktree}"`);
  fs.writeFileSync(path.join(ticketWorktree, 'file.txt'), 'changed\n');
  execSync('git add -A && git commit -m work', { cwd: ticketWorktree, stdio: 'ignore' });
});

after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('check-setup resolves its report folder from TASKS_BASE', () => {
  it('uses TASKS_BASE, not the worktrees-sibling guess', () => {
    const { ok, result } = runSetup({ cwd: ticketWorktree });
    assert.equal(ok, true, 'check-setup should succeed with TASKS_BASE configured');

    assert.equal(
      path.resolve(result.reportFolder),
      path.resolve(path.join(tasksBase, TICKET)),
      'reportFolder must sit under the configured TASKS_BASE'
    );
    assert.notEqual(
      path.resolve(result.reportFolder),
      path.resolve(path.join(worktreesBase, 'tasks', TICKET)),
      'the <mainWorktree>/../tasks guess is what split /check in two'
    );
  });

  it('puts screenshots under the same resolved folder', () => {
    const { result } = runSetup({ cwd: ticketWorktree });
    assert.equal(
      path.resolve(result.screenshotsFolder),
      path.resolve(path.join(tasksBase, TICKET, 'screenshots'))
    );
  });

  it('resolves identically from the main worktree and from a ticket worktree', () => {
    const fromTicket = runSetup({ cwd: ticketWorktree }).result;
    const fromMain = runSetup({ cwd: mainRepo }).result;
    assert.equal(
      path.resolve(fromTicket.reportFolder),
      path.resolve(fromMain.reportFolder),
      'the report folder must not depend on which worktree /check runs in'
    );
  });

  it('refuses rather than guessing when TASKS_BASE is unset', () => {
    // WORKTREES_BASE alone must NOT be enough — deriving <WORKTREES_BASE>/tasks
    // is exactly the guess resolve-base-dirs.js refuses to make.
    const { ok, result, status } = runSetup({
      cwd: ticketWorktree,
      env: { TASKS_BASE: undefined },
    });
    assert.equal(ok, false, 'must not succeed with an unresolved TASKS_BASE');
    assert.equal(status, 1);
    assert.ok(result && result.error, `expected a structured error, got ${JSON.stringify(result)}`);
    assert.match(result.error, /TASKS_BASE/);
    assert.equal(result.reportFolder, undefined, 'must not emit a guessed folder');
  });
});

describe('check-setup reports stranded pre-fix artifacts', () => {
  it('names the legacy folder when it still holds check reports', () => {
    const legacy = path.join(worktreesBase, 'tasks', TICKET);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'tests.check.md'), '**Status:** APPROVED\n');
    try {
      const { result } = runSetup({ cwd: ticketWorktree });
      assert.equal(
        path.resolve(result.legacyReportFolder),
        path.resolve(legacy),
        'stranded reports must be surfaced, not silently orphaned'
      );
      // Reported, never touched.
      assert.ok(fs.existsSync(path.join(legacy, 'tests.check.md')), 'must not move or delete');
      assert.ok(
        !fs.existsSync(path.join(tasksBase, TICKET, 'tests.check.md')),
        'must not copy stale reports where the check gate reads them'
      );
    } finally {
      fs.rmSync(path.join(worktreesBase, 'tasks'), { recursive: true, force: true });
    }
  });

  it('omits the field when nothing is stranded', () => {
    const { result } = runSetup({ cwd: ticketWorktree });
    assert.equal(result.legacyReportFolder, undefined);
  });
});
