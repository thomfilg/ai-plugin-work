/**
 * enforce-screenshot-dir.test.js
 *
 * getScreenshotDir used to end with
 *
 *   return path.join(process.cwd(), '..', 'tasks', ticketId, 'screenshots');
 *
 * A hook's cwd is wherever the agent happened to be, so that invented a
 * plausible path with no relationship to the repo — from a ticket worktree it
 * produced the same `<worktrees>/tasks/...` split check-setup.js was making.
 * Worse, the caller read "directory does not exist" as "no screenshots", so a
 * guess pointing nowhere made the hook BLOCK instead of failing open.
 *
 * These lock the resolution order: the configured tasks root wins, and an
 * unresolvable root declines to enforce instead of blocking on a guess.
 *
 * Uses node:test + node:assert/strict.
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'hooks', 'enforce-screenshot-requirement.js');

let tasksBase;
let savedTasksBase;
let savedWorktreesBase;

/**
 * Call the hook's resolvers in a fresh process, so `cwd`, the env and the
 * module-level repo-root cache are all controlled per case.
 */
function resolveIn({ cwd, env = {}, expr }) {
  const childEnv = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      `const m = require(${JSON.stringify(HOOK)}); process.stdout.write(JSON.stringify(${expr}))`,
    ],
    { cwd, env: childEnv, encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  return JSON.parse(out);
}

before(() => {
  savedTasksBase = process.env.TASKS_BASE;
  savedWorktreesBase = process.env.WORKTREES_BASE;
  tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-dir-'));
});

after(() => {
  if (savedTasksBase === undefined) delete process.env.TASKS_BASE;
  else process.env.TASKS_BASE = savedTasksBase;
  if (savedWorktreesBase === undefined) delete process.env.WORKTREES_BASE;
  else process.env.WORKTREES_BASE = savedWorktreesBase;
  fs.rmSync(tasksBase, { recursive: true, force: true });
});

describe('enforce-screenshot-requirement: screenshots dir resolution', () => {
  it('uses the configured tasks root, never a cwd-relative guess', () => {
    const dir = resolveIn({
      cwd: os.tmpdir(),
      env: { TASKS_BASE: tasksBase, WORKTREES_BASE: undefined },
      expr: `m.getScreenshotDir('ECHO-6842')`,
    });
    assert.equal(
      path.resolve(dir),
      path.resolve(path.join(tasksBase, 'ECHO-6842', 'screenshots')),
      'configured TASKS_BASE must win'
    );
  });

  it('returns null — not a cwd guess — when nothing configures a tasks root', () => {
    // No TASKS_BASE, no WORKTREES_BASE, and a cwd outside any git repo, so the
    // configured lookup and the repo-anchored fallback both come back empty.
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      const dir = resolveIn({
        cwd: nonRepo,
        env: { TASKS_BASE: undefined, WORKTREES_BASE: undefined },
        expr: `m.getScreenshotDir('ECHO-6842')`,
      });
      assert.equal(dir, null, 'an unresolvable tasks root must not be guessed from cwd');
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it('an unresolvable root reads as satisfied, so the hook fails open', () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      const satisfied = resolveIn({
        cwd: nonRepo,
        env: { TASKS_BASE: undefined, WORKTREES_BASE: undefined },
        expr: `m.hasScreenshots('ECHO-6842')`,
      });
      assert.equal(
        satisfied,
        true,
        'reporting "no screenshots" for a directory we could not resolve is what blocked'
      );
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it('still reports genuinely missing screenshots under a configured root', () => {
    const missing = resolveIn({
      cwd: os.tmpdir(),
      env: { TASKS_BASE: tasksBase, WORKTREES_BASE: undefined },
      expr: `m.hasScreenshots('TICKET-WITH-NO-DIR')`,
    });
    assert.equal(missing, false, 'a resolvable but empty dir is still missing screenshots');
  });

  it('reports screenshots that exist under the configured root', () => {
    const shots = path.join(tasksBase, 'ECHO-7000', 'screenshots');
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, 'home.png'), 'x');
    const found = resolveIn({
      cwd: os.tmpdir(),
      env: { TASKS_BASE: tasksBase, WORKTREES_BASE: undefined },
      expr: `m.hasScreenshots('ECHO-7000')`,
    });
    assert.equal(found, true);
  });
});
