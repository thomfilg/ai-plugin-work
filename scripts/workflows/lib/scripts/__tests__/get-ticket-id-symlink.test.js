/**
 * Regression test: getCurrentTaskId() must prefer the git branch over the
 * worktree cwd path when they disagree (symlinked-worktree scenario).
 *
 * Repro of the symlinked-worktree bug: dir was named tabwoah-ECHO-4628
 * but the checked-out branch was feature/echo-4630-..., so the old code
 * (cwd-first) returned ECHO-4628 and downstream consumers looked up the
 * wrong tasks/<id>/ snapshot.
 *
 * Run: node --test ./scripts/workflows/lib/scripts/__tests__/get-ticket-id-symlink.test.js
 */

'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

function freshRequire(mod) {
  const resolved = require.resolve(mod);
  delete require.cache[resolved];
  return require(mod);
}

function makeRepo(branchName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'getticketid-'));
  execSync(`git init -q -b ${branchName}`, { cwd: dir });
  execSync('git config user.email t@t', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'x'), '');
  execSync('git add x', { cwd: dir });
  execSync(['git', 'commit', '-q', '-m', 'init'].join(' '), { cwd: dir });
  return dir;
}

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) {
    try {
      fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
    } catch {}
  }
});

describe('getCurrentTaskId — branch wins over cwd when they disagree', () => {
  it('cwd says ECHO-4628 but branch says ECHO-4630 → returns ECHO-4630 (the ECHO-4630 follow-up bug)', () => {
    const realDir = makeRepo('feature/echo-4630-wire-component');
    tmpDirs.push(realDir);
    // Simulate "tabwoah-ECHO-4628" worktree dir naming. We can't easily
    // rename the temp dir, so symlink it to a name that contains the
    // wrong ticket id and pass THAT as cwd.
    const linkName = path.join(path.dirname(realDir), 'tabwoah-ECHO-4628');
    fs.symlinkSync(realDir, linkName);
    tmpDirs.push(linkName);

    const { getCurrentTaskId } = freshRequire('../get-ticket-id');
    assert.equal(getCurrentTaskId(linkName), 'ECHO-4630');
  });

  it('cwd has no ticket pattern; branch has ECHO-9999 → returns ECHO-9999', () => {
    const dir = makeRepo('feature/echo-9999-some-thing');
    tmpDirs.push(dir);
    const { getCurrentTaskId } = freshRequire('../get-ticket-id');
    assert.equal(getCurrentTaskId(dir), 'ECHO-9999');
  });

  it('cwd has ticket but branch is generic (main) → falls back to cwd ticket', () => {
    const dir = makeRepo('main');
    tmpDirs.push(dir);
    const linkName = path.join(path.dirname(dir), 'work-PROJ-321');
    fs.symlinkSync(dir, linkName);
    tmpDirs.push(linkName);
    const { getCurrentTaskId } = freshRequire('../get-ticket-id');
    assert.equal(getCurrentTaskId(linkName), 'PROJ-321');
  });

  it('git lookup fails (non-existent path) → falls back to cwd matching (test compatibility)', () => {
    const { getCurrentTaskId } = freshRequire('../get-ticket-id');
    assert.equal(getCurrentTaskId('/tmp/does/not/exist/work-FOO-7'), 'FOO-7');
  });

  it('WORK_TICKET_ID env var still wins over everything', () => {
    const dir = makeRepo('feature/echo-1234-x');
    tmpDirs.push(dir);
    const prev = process.env.WORK_TICKET_ID;
    process.env.WORK_TICKET_ID = 'OVERRIDE-1';
    try {
      const { getCurrentTaskId } = freshRequire('../get-ticket-id');
      assert.equal(getCurrentTaskId(dir), 'OVERRIDE-1');
    } finally {
      if (prev === undefined) delete process.env.WORK_TICKET_ID;
      else process.env.WORK_TICKET_ID = prev;
    }
  });
});
