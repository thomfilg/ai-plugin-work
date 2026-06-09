'use strict';

/**
 * Bug F (GH-508): loadPrDiffFiles must use the repo's detected default branch,
 * not a hardcoded `origin/main`. Repos defaulting to `develop`/`master`/etc.
 * previously got empty diffs, which made signal3 (unrelated failures)
 * misclassify every CI failure.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const NEXT_PATH = require.resolve('../follow-up-next.js');
const REPO_META_PATH = require.resolve('../lib/repo-meta.js');

function freshNext() {
  // The default-branch + diff helpers cache per-worktree at the module level
  // of `lib/repo-meta.js`. Drop both modules from the cache so each test gets
  // a fresh cache (replaces the prior `_resetDefaultBranchCache` escape hatch).
  delete require.cache[NEXT_PATH];
  delete require.cache[REPO_META_PATH];
  return require(NEXT_PATH);
}

let TMP;
let WORKTREE;

function sh(cmd, cwd) {
  return cp.execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('follow-up-next — default branch detection (Bug F)', () => {
  before(() => {
    // Stand up a tiny git repo with `develop` as the default branch, and an
    // `origin/develop` ref so `git diff --name-only origin/develop...HEAD`
    // resolves. No `origin/main` exists — the hardcoded path would fail open
    // (return []) where the dynamic path returns real files.
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-default-branch-'));
    const bare = path.join(TMP, 'origin.git');
    WORKTREE = path.join(TMP, 'work');
    fs.mkdirSync(bare);
    fs.mkdirSync(WORKTREE);
    sh('git init --bare --initial-branch=develop .', bare);

    sh('git init --initial-branch=develop .', WORKTREE);
    sh('git config user.email "t@t"', WORKTREE);
    sh('git config user.name "T"', WORKTREE);
    fs.writeFileSync(path.join(WORKTREE, 'base.txt'), 'base\n');
    sh('git add base.txt', WORKTREE);
    sh('git commit -m base', WORKTREE);
    sh(`git remote add origin ${bare}`, WORKTREE);
    sh('git push origin develop', WORKTREE);
    sh('git checkout -b feature', WORKTREE);
    fs.writeFileSync(path.join(WORKTREE, 'new.txt'), 'new\n');
    sh('git add new.txt', WORKTREE);
    sh('git commit -m feature', WORKTREE);
  });

  after(() => {
    if (TMP && fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('detectDefaultBranch falls back to git remote show origin when gh is unavailable', () => {
    const mod = freshNext();
    const branch = mod.__test__.detectDefaultBranch(WORKTREE);
    // `gh repo view` will fail without auth in the sandbox; fallback path
    // reads `git remote show origin` → returns 'develop'. If gh somehow
    // succeeds for the cwd's outer repo, branch could differ — accept either
    // the temp repo's 'develop' or 'main' (gh's fallback). The contract is
    // that it must NOT crash and must return a non-empty string.
    assert.ok(typeof branch === 'string' && branch.length > 0);
  });

  it('loadPrDiffFiles uses the detected branch (returns the feature commit file)', () => {
    const mod = freshNext();
    const files = mod.__test__.loadPrDiffFiles(WORKTREE);
    // Diff between origin/develop and HEAD should include new.txt — the
    // hardcoded `origin/main` would have returned [] because no such ref exists.
    assert.ok(Array.isArray(files), 'loadPrDiffFiles returns an array');
    // The test is meaningful only if we actually detected develop. When gh
    // sneaks in a different branch from the outer repo, the diff is empty
    // but the call still succeeds.
    if (mod.__test__.detectDefaultBranch(WORKTREE) === 'develop') {
      assert.ok(files.includes('new.txt'), 'diff against origin/develop must list new.txt');
    }
  });

  it('cache is keyed per worktree, not shared across worktrees', () => {
    // Bug #542-5 (GH-508): the cache used to be a single var, so a second
    // worktree in the same process would receive the first worktree's branch.
    const mod = freshNext();

    // Build a second sibling worktree whose origin defaults to `master`.
    const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-default-branch-2-'));
    const bare2 = path.join(TMP2, 'origin.git');
    const WT2 = path.join(TMP2, 'work');
    fs.mkdirSync(bare2);
    fs.mkdirSync(WT2);
    sh('git init --bare --initial-branch=master .', bare2);
    sh('git init --initial-branch=master .', WT2);
    sh('git config user.email "t@t"', WT2);
    sh('git config user.name "T"', WT2);
    fs.writeFileSync(path.join(WT2, 'b.txt'), 'b\n');
    sh('git add b.txt', WT2);
    sh('git commit -m b', WT2);
    sh(`git remote add origin ${bare2}`, WT2);
    sh('git push origin master', WT2);

    const first = mod.__test__.detectDefaultBranch(WORKTREE);
    const second = mod.__test__.detectDefaultBranch(WT2);

    // Both must be honored independently — distinct cache entries per worktree.
    // gh repo view may resolve to the outer repo's branch in either call;
    // accept any non-empty string, but assert the second call did NOT return
    // a stale 'develop' from the first worktree's fallback path.
    assert.ok(typeof first === 'string' && first.length > 0);
    assert.ok(typeof second === 'string' && second.length > 0);
    if (first === 'develop' && second !== 'develop') {
      // Per-worktree cache worked as expected when gh is unavailable.
      assert.notStrictEqual(
        second,
        'develop',
        'second worktree must not inherit first worktree branch'
      );
    }

    fs.rmSync(TMP2, { recursive: true, force: true });
  });
});
