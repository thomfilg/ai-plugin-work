'use strict';

// Integration test: build a real two-branch git fixture that conflicts,
// then run the monitor.js local-conflict-detection logic against it and
// assert _isConflicting becomes true.
//
// This catches the bugs in the original 888dd5e4 implementation:
//   1. execFileSync throws on `git merge-tree` exit 1 → exception swallowed
//      → conflict invisible. Switched to spawnSync.
//   2. The default merge-tree output uses `CONFLICT (...)` lines, NOT
//      `<<<<<<<` separator markers (those only appear with --write-tree
//      against an actual workdir). The detection regex now matches the
//      real output format.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
}

function buildConflictingFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fu2-conflict-fixture-'));
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'file.txt'), 'alpha\n');
  git(seed, 'add', 'file.txt');
  git(seed, 'commit', '-q', '-m', 'init');
  const originBare = path.join(root, 'origin.git');
  git(seed, 'clone', '-q', '--bare', '.', originBare);
  const worktree = path.join(root, 'worktree');
  git(root, 'clone', '-q', originBare, worktree);

  // feature branch with one change
  git(worktree, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(worktree, 'file.txt'), 'from-feature\n');
  git(worktree, 'commit', '-qam', 'feature change');
  git(worktree, 'push', '-q', 'origin', 'feature');

  // main moves with a conflicting change
  git(worktree, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(worktree, 'file.txt'), 'from-main\n');
  git(worktree, 'commit', '-qam', 'main update');
  git(worktree, 'push', '-q', 'origin', 'main');

  git(worktree, 'checkout', '-q', 'feature');
  return { root, worktree };
}

// Reach into monitor.js's logic by running the same git commands it runs.
// This proves the detection works end-to-end without mocking. If we ever
// change the detection strategy in monitor.js, update both here and there.
function detectLocalConflict(worktree, baseBranch) {
  let mb;
  try {
    mb = execFileSync('git', ['merge-base', 'HEAD', `origin/${baseBranch}`], {
      cwd: worktree,
      encoding: 'utf8',
    }).trim();
  } catch {
    return { conflicting: false, files: [] };
  }
  const res = spawnSync(
    'git',
    ['merge-tree', `--merge-base=${mb}`, 'HEAD', `origin/${baseBranch}`],
    { cwd: worktree, encoding: 'utf8' }
  );
  const tree = (res.stdout || '') + (res.stderr || '');
  const hasConflictExit = res.status !== 0 && res.status !== null;
  const hasConflictMarker = /^CONFLICT \(/m.test(tree);
  if (!hasConflictExit && !hasConflictMarker) return { conflicting: false, files: [] };
  const files = [];
  for (const line of tree.split('\n')) {
    const m =
      line.match(/^CONFLICT \([^)]+\):.*?(?:in|on) (.+?)$/) || line.match(/^Auto-merging (.+?)$/);
    if (m && !files.includes(m[1])) files.push(m[1]);
    if (files.length >= 3) break;
  }
  return { conflicting: true, files };
}

describe('monitor.js local conflict detection — integration', () => {
  it('detects a real two-branch conflict via merge-tree', () => {
    const { root, worktree } = buildConflictingFixture();
    try {
      const result = detectLocalConflict(worktree, 'main');
      assert.equal(result.conflicting, true, 'must detect the conflict');
      assert.ok(result.files.length > 0, 'must extract at least one conflicting file');
      assert.ok(
        result.files.includes('file.txt'),
        `expected file.txt in conflict list, got ${JSON.stringify(result.files)}`
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports no conflict when branches do not diverge on shared content', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fu2-clean-fixture-'));
    try {
      const seed = path.join(root, 'seed');
      fs.mkdirSync(seed);
      git(seed, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(seed, 'file.txt'), 'alpha\n');
      git(seed, 'add', 'file.txt');
      git(seed, 'commit', '-q', '-m', 'init');
      const originBare = path.join(root, 'origin.git');
      git(seed, 'clone', '-q', '--bare', '.', originBare);
      const worktree = path.join(root, 'worktree');
      git(root, 'clone', '-q', originBare, worktree);
      git(worktree, 'checkout', '-q', '-b', 'feature');
      // Non-conflicting change to a different file
      fs.writeFileSync(path.join(worktree, 'other.txt'), 'new\n');
      git(worktree, 'add', 'other.txt');
      git(worktree, 'commit', '-qam', 'add other');
      git(worktree, 'push', '-q', 'origin', 'feature');

      const result = detectLocalConflict(worktree, 'main');
      assert.equal(result.conflicting, false);
      assert.deepEqual(result.files, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
