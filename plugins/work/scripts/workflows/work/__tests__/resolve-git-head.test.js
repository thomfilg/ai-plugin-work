/**
 * Tests for resolveGitHead logic (GH-260 Issue 1)
 *
 * Verifies that the resolveGitHead helper correctly handles
 * worktree .git files (which contain "gitdir: <path>").
 *
 * Uses node:test + node:assert/strict with temp directories.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveGitHead, getHeadSha } = require('../lib/git-utils');

describe('resolveGitHead (GH-260 Issue 1)', () => {
  const tmpDirs = [];

  function makeTmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh260-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('should read HEAD from the gitdir path in a worktree .git file', () => {
    const worktree = makeTmpDir();
    const gitdir = makeTmpDir();

    fs.writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/GH-260-fix\n');
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitdir}\n`);

    const result = resolveGitHead(worktree);
    assert.equal(result, 'ref: refs/heads/GH-260-fix', 'Should read HEAD from gitdir');
  });

  it('should handle relative gitdir paths in worktree .git file', () => {
    const worktree = makeTmpDir();
    const mainRepoParent = makeTmpDir();
    const mainRepo = path.join(mainRepoParent, '.git');
    fs.mkdirSync(mainRepo, { recursive: true });
    fs.mkdirSync(path.join(mainRepo, 'worktrees', 'wt1'), { recursive: true });
    fs.writeFileSync(
      path.join(mainRepo, 'worktrees', 'wt1', 'HEAD'),
      'ref: refs/heads/feature-branch\n'
    );

    const relPath = path.relative(worktree, path.join(mainRepo, 'worktrees', 'wt1'));
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${relPath}\n`);

    const result = resolveGitHead(worktree);
    assert.equal(result, 'ref: refs/heads/feature-branch', 'Should resolve relative gitdir');
  });

  it('should read HEAD directly when .git is a directory (normal repo)', () => {
    const repo = makeTmpDir();
    const dotgitDir = path.join(repo, '.git');
    fs.mkdirSync(dotgitDir);
    fs.writeFileSync(path.join(dotgitDir, 'HEAD'), 'ref: refs/heads/main\n');

    const result = resolveGitHead(repo);
    assert.equal(result, 'ref: refs/heads/main', 'Should read HEAD from .git directory');
  });

  it('should throw for unexpected .git content', () => {
    const worktree = makeTmpDir();
    fs.writeFileSync(path.join(worktree, '.git'), 'some random content\n');

    assert.throws(
      () => resolveGitHead(worktree),
      /unexpected \.git content/,
      'Should throw for non-gitdir content'
    );
  });
});

describe('getHeadSha (GH-299 Task 1)', () => {
  const { execFileSync } = require('child_process');

  it('should return a 40-char hex string in a self-contained temp git repo', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh299-git-'));
    try {
      // Create a self-contained git repo so test doesn't depend on outer checkout
      const gitOpts = { cwd: tmpDir, stdio: 'ignore', timeout: 5000 };
      execFileSync('git', ['init'], gitOpts);
      execFileSync('git', ['config', 'user.email', 'test@test.com'], gitOpts);
      execFileSync('git', ['config', 'user.name', 'Test'], gitOpts);
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'test');
      execFileSync('git', ['add', '.'], gitOpts);
      execFileSync('git', ['commit', '-m', 'init'], gitOpts);

      const sha = getHeadSha(tmpDir);
      assert.notEqual(sha, null, 'Should not be null in a git repo');
      assert.match(sha, /^[0-9a-f]{40}$/, 'Should be a 40-char hex SHA');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should return null when git fails (non-git directory)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh299-'));
    try {
      const sha = getHeadSha(tmpDir);
      assert.equal(sha, null, 'Should return null in a non-git directory');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
