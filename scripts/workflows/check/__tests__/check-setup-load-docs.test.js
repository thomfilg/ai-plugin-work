/**
 * Tests for loadDocsFromPaths in check-setup.js
 *
 * Covers the WORKTREES_BASE boundary expansion: when WORKTREES_BASE is set,
 * READ_DOCS_ON_* paths that resolve within it (but outside the repo root)
 * should be allowed, skipping the git ls-files check for those files.
 *
 * Uses node:test + node:assert/strict.
 * Run: node --test hooks/__tests__/check-setup-load-docs.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ─── Test Fixtures ──────────────────────────────────────────────────────────

let tempDir;
let repoRoot;
let worktreesBase;
let sharedDocsDir;

// Require the module once (bust cache on first load)
let _mod;
function getModule() {
  if (!_mod) {
    const modPath = path.join(__dirname, '..', 'hooks', 'check-setup.js');
    delete require.cache[modPath];
    const configPath = path.join(__dirname, '..', '..', 'lib', 'config.js');
    delete require.cache[configPath];
    _mod = require(modPath);
  }
  return _mod;
}

/**
 * Call loadDocsFromPaths with env overrides active during the call.
 * Returns the result; env is restored after.
 */
function callWithEnv(envOverrides, envVarName, csvPaths, repoRootArg) {
  const mod = getModule();
  const oldEnv = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    oldEnv[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return mod.loadDocsFromPaths(envVarName, csvPaths, repoRootArg);
  } finally {
    for (const [k, v] of Object.entries(oldEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

before(() => {
  // Create a temp directory structure simulating a worktrees layout:
  // tempDir/
  //   worktrees-base/
  //     my-repo/          <-- git repo root
  //       tracked-doc.md  <-- git-tracked file
  //     rules/            <-- shared docs outside repo
  //       ui.md
  //       team-conventions.md
  //       .env.local      <-- sensitive file (should be denied)
  //       huge-file.md    <-- oversized file
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-setup-test-'));
  worktreesBase = path.join(tempDir, 'worktrees-base');
  repoRoot = path.join(worktreesBase, 'my-repo');
  sharedDocsDir = path.join(worktreesBase, 'rules');

  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(sharedDocsDir, { recursive: true });

  // Initialize a minimal git repo so git ls-files works
  execSync('git init', { cwd: repoRoot, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: repoRoot, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: repoRoot, stdio: 'ignore' });

  // Create and track a file inside the repo
  fs.writeFileSync(path.join(repoRoot, 'tracked-doc.md'), '# Tracked Doc\nContent here.');
  execSync('git add tracked-doc.md', { cwd: repoRoot, stdio: 'ignore' });
  execSync('git commit -m "init"', { cwd: repoRoot, stdio: 'ignore' });

  // Create shared docs outside the repo but inside worktrees base
  fs.writeFileSync(path.join(sharedDocsDir, 'ui.md'), '# UI Guidelines\nUse design tokens.');
  fs.writeFileSync(
    path.join(sharedDocsDir, 'team-conventions.md'),
    '# Team Conventions\nReview all PRs.'
  );

  // Create a sensitive file that should be rejected by denylist
  fs.writeFileSync(path.join(sharedDocsDir, '.env.local'), 'SECRET=bad');

  // Create an oversized file (>256KB)
  fs.writeFileSync(path.join(sharedDocsDir, 'huge-file.md'), 'x'.repeat(300 * 1024));
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('loadDocsFromPaths', () => {
  describe('existing behavior (no WORKTREES_BASE)', () => {
    it('loads a git-tracked file within repo root', () => {
      const result = callWithEnv(
        { WORKTREES_BASE: undefined },
        'READ_DOCS_ON_DEV',
        'tracked-doc.md',
        repoRoot
      );
      assert.ok(result.includes('# Tracked Doc'), 'should contain tracked doc content');
      assert.ok(result.includes('--- tracked-doc.md ---'), 'should contain file header');
    });

    it('rejects paths that escape repo root when WORKTREES_BASE is not set', () => {
      const result = callWithEnv(
        { WORKTREES_BASE: undefined },
        'READ_DOCS_ON_DEV',
        '../rules/ui.md',
        repoRoot
      );
      assert.equal(result, '', 'should return empty string for path escaping repo root');
    });

    it('rejects absolute paths', () => {
      const absPath = path.join(sharedDocsDir, 'ui.md');
      const result = callWithEnv(
        { WORKTREES_BASE: undefined },
        'READ_DOCS_ON_DEV',
        absPath,
        repoRoot
      );
      assert.equal(result, '', 'should reject absolute paths');
    });

    it('rejects sensitive files by denylist', () => {
      const result = callWithEnv(
        { WORKTREES_BASE: undefined },
        'READ_DOCS_ON_DEV',
        '.env.local',
        repoRoot
      );
      assert.equal(result, '', 'should reject .env.local');
    });
  });

  describe('WORKTREES_BASE boundary expansion', () => {
    it('allows paths that resolve within WORKTREES_BASE but outside repo root', () => {
      const result = callWithEnv(
        { WORKTREES_BASE: worktreesBase },
        'READ_DOCS_ON_DEV',
        '../rules/ui.md',
        repoRoot
      );
      assert.ok(result.includes('# UI Guidelines'), 'should contain shared doc content');
      assert.ok(result.includes('--- ../rules/ui.md ---'), 'should contain file header');
    });

    it('loads multiple shared docs via CSV', () => {
      const result = callWithEnv(
        { WORKTREES_BASE: worktreesBase },
        'READ_DOCS_ON_DEV',
        '../rules/ui.md,../rules/team-conventions.md',
        repoRoot
      );
      assert.ok(result.includes('# UI Guidelines'), 'should contain first doc');
      assert.ok(result.includes('# Team Conventions'), 'should contain second doc');
    });

    it('still loads git-tracked files within repo root', () => {
      const result = callWithEnv(
        { WORKTREES_BASE: worktreesBase },
        'READ_DOCS_ON_DEV',
        'tracked-doc.md',
        repoRoot
      );
      assert.ok(result.includes('# Tracked Doc'), 'should still load repo files');
    });

    it('rejects paths that escape WORKTREES_BASE', () => {
      // ../../ goes above worktreesBase
      const result = callWithEnv(
        { WORKTREES_BASE: worktreesBase },
        'READ_DOCS_ON_DEV',
        '../../etc/passwd',
        repoRoot
      );
      assert.equal(result, '', 'should reject path escaping WORKTREES_BASE');
    });

    it('still rejects sensitive files in WORKTREES_BASE', () => {
      const result = callWithEnv(
        { WORKTREES_BASE: worktreesBase },
        'READ_DOCS_ON_DEV',
        '../rules/.env.local',
        repoRoot
      );
      assert.equal(result, '', 'should reject sensitive files even within WORKTREES_BASE');
    });

    it('still rejects oversized files in WORKTREES_BASE', () => {
      const result = callWithEnv(
        { WORKTREES_BASE: worktreesBase },
        'READ_DOCS_ON_DEV',
        '../rules/huge-file.md',
        repoRoot
      );
      assert.equal(result, '', 'should reject files exceeding 256KB');
    });

    it('still rejects absolute paths even with WORKTREES_BASE set', () => {
      const absPath = path.join(sharedDocsDir, 'ui.md');
      const result = callWithEnv(
        { WORKTREES_BASE: worktreesBase },
        'READ_DOCS_ON_DEV',
        absPath,
        repoRoot
      );
      assert.equal(result, '', 'should reject absolute paths');
    });

    it('skips git ls-files check for files outside repo but within WORKTREES_BASE', () => {
      // The shared docs are NOT git-tracked. If git ls-files were checked,
      // they would be rejected. This test verifies they load successfully.
      const result = callWithEnv(
        { WORKTREES_BASE: worktreesBase },
        'READ_DOCS_ON_DEV',
        '../rules/ui.md',
        repoRoot
      );
      assert.ok(
        result.includes('# UI Guidelines'),
        'should load non-git-tracked files within WORKTREES_BASE'
      );
    });

    it('handles symlinks within WORKTREES_BASE correctly', () => {
      // Create a symlink inside worktreesBase pointing to a file within worktreesBase
      const symlinkPath = path.join(sharedDocsDir, 'ui-link.md');
      try {
        fs.unlinkSync(symlinkPath);
      } catch {
        /* ignore */
      }
      fs.symlinkSync(path.join(sharedDocsDir, 'ui.md'), symlinkPath);

      const result = callWithEnv(
        { WORKTREES_BASE: worktreesBase },
        'READ_DOCS_ON_DEV',
        '../rules/ui-link.md',
        repoRoot
      );
      assert.ok(result.includes('# UI Guidelines'), 'should follow symlinks within WORKTREES_BASE');

      fs.unlinkSync(symlinkPath);
    });

    it('rejects symlinks that escape WORKTREES_BASE', () => {
      // Create a symlink inside worktreesBase pointing outside
      const escapePath = path.join(os.tmpdir(), 'escape-target.md');
      fs.writeFileSync(escapePath, 'escaped content');
      const symlinkPath = path.join(sharedDocsDir, 'escape-link.md');
      try {
        fs.unlinkSync(symlinkPath);
      } catch {
        /* ignore */
      }
      fs.symlinkSync(escapePath, symlinkPath);

      const result = callWithEnv(
        { WORKTREES_BASE: worktreesBase },
        'READ_DOCS_ON_DEV',
        '../rules/escape-link.md',
        repoRoot
      );
      assert.equal(result, '', 'should reject symlinks escaping WORKTREES_BASE');

      fs.unlinkSync(symlinkPath);
      fs.unlinkSync(escapePath);
    });

    it('handles non-existent files gracefully', () => {
      const result = callWithEnv(
        { WORKTREES_BASE: worktreesBase },
        'READ_DOCS_ON_DEV',
        '../rules/missing.md',
        repoRoot
      );
      assert.equal(result, '', 'should return empty for non-existent files');
    });
  });
});
