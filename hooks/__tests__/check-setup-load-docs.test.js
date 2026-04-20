const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Tests for loadDocsFromPaths in hooks/check-setup.js
 *
 * Focuses on the WORKTREES_BASE boundary expansion:
 * When WORKTREES_BASE is set, paths that resolve within it (but outside
 * repo root) should be allowed — without requiring git ls-files tracking.
 */

// We'll build a temp directory structure:
//   tmpDir/
//     worktrees-base/
//       repo/             ← simulated repo root (contains .git)
//         tracked.md      ← git-tracked file
//       rules/
//         ui.md           ← shared doc outside repo but inside WORKTREES_BASE
//       secrets/
//         .env            ← denied by denylist even inside WORKTREES_BASE
//     outside/
//       escape.md         ← completely outside both boundaries

let tmpDir;
let repoRoot;
let worktreesBase;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-setup-test-'));
  worktreesBase = path.join(tmpDir, 'worktrees-base');
  repoRoot = path.join(worktreesBase, 'repo');

  // Create directory structure
  fs.mkdirSync(path.join(worktreesBase, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'outside'), { recursive: true });
  fs.mkdirSync(path.join(worktreesBase, 'secrets'), { recursive: true });

  // Create test files
  fs.writeFileSync(path.join(repoRoot, 'tracked.md'), '# Tracked doc');
  fs.writeFileSync(path.join(worktreesBase, 'rules', 'ui.md'), '# UI Rules');
  fs.writeFileSync(path.join(worktreesBase, 'secrets', '.env'), 'SECRET=bad');
  fs.writeFileSync(path.join(tmpDir, 'outside', 'escape.md'), '# Escaped');

  // Large file (> 256 KB)
  fs.writeFileSync(
    path.join(worktreesBase, 'rules', 'huge.md'),
    'x'.repeat(257 * 1024)
  );
}

function cleanup() {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Load module fresh with a specific WORKTREES_BASE env value.
 * We need to clear the require cache each time because config.js
 * reads env vars at require time.
 */
function loadModule(worktreesBaseValue) {
  // Clear cached modules
  const modulePath = path.resolve(__dirname, '..', 'check-setup.js');
  const configPath = path.resolve(__dirname, '..', '..', 'lib', 'config.js');

  // Clear all cached modules that might hold stale config
  for (const key of Object.keys(require.cache)) {
    if (key.includes('check-setup') || key.includes('lib/config')) {
      delete require.cache[key];
    }
  }

  // Set env before requiring
  if (worktreesBaseValue !== undefined) {
    process.env.WORKTREES_BASE = worktreesBaseValue;
  } else {
    delete process.env.WORKTREES_BASE;
  }

  const mod = require(modulePath);
  return mod.loadDocsFromPaths;
}

describe('loadDocsFromPaths — WORKTREES_BASE support', () => {
  beforeEach(() => {
    setup();
  });

  afterEach(() => {
    cleanup();
    delete process.env.WORKTREES_BASE;
  });

  it('allows paths inside WORKTREES_BASE but outside repo root', () => {
    const loadDocs = loadModule(worktreesBase);
    // ../rules/ui.md relative to repoRoot resolves inside worktreesBase
    const result = loadDocs('READ_DOCS_ON_DEV', '../rules/ui.md', repoRoot);
    assert.ok(result.includes('# UI Rules'), 'Should load doc from WORKTREES_BASE');
    assert.ok(result.includes('--- ../rules/ui.md ---'), 'Should include file header');
  });

  it('rejects paths outside both repo root and WORKTREES_BASE', () => {
    const loadDocs = loadModule(worktreesBase);
    // ../../outside/escape.md escapes worktreesBase
    const result = loadDocs('READ_DOCS_ON_DEV', '../../outside/escape.md', repoRoot);
    assert.equal(result, '', 'Should reject path outside both boundaries');
  });

  it('still allows paths inside repo root (existing behavior)', () => {
    const loadDocs = loadModule(worktreesBase);
    // We can't use git ls-files in a fake repo, so we need to mock that.
    // For now, test that the path validation passes for repo-internal paths
    // by verifying it does NOT log "escapes repo root" for an in-repo path.
    // The git ls-files check will fail since our test repo isn't a real git repo,
    // but the boundary check should pass.
    const warnings = [];
    const origError = console.error;
    console.error = (msg) => warnings.push(msg);
    try {
      loadDocs('READ_DOCS_ON_DEV', 'tracked.md', repoRoot);
      // It may fail at git ls-files, but should NOT fail at boundary check
      const boundaryWarning = warnings.find(w => w.includes('escapes repo root'));
      assert.equal(boundaryWarning, undefined, 'In-repo path should not trigger boundary warning');
    } finally {
      console.error = origError;
    }
  });

  it('still applies denylist for paths inside WORKTREES_BASE', () => {
    const loadDocs = loadModule(worktreesBase);
    const result = loadDocs('READ_DOCS_ON_DEV', '../secrets/.env', repoRoot);
    assert.equal(result, '', 'Denylist should still block .env inside WORKTREES_BASE');
  });

  it('still applies size cap for files inside WORKTREES_BASE', () => {
    const loadDocs = loadModule(worktreesBase);
    const result = loadDocs('READ_DOCS_ON_DEV', '../rules/huge.md', repoRoot);
    assert.equal(result, '', 'Size cap should still apply inside WORKTREES_BASE');
  });

  it('skips git ls-files check for files outside repo but inside WORKTREES_BASE', () => {
    const loadDocs = loadModule(worktreesBase);
    // If git ls-files were checked, it would fail since ../rules/ui.md is not tracked.
    // This test verifies the file loads successfully (git ls-files skipped).
    const result = loadDocs('READ_DOCS_ON_DEV', '../rules/ui.md', repoRoot);
    assert.ok(result.includes('# UI Rules'), 'Should skip git ls-files for shared docs');
  });

  it('falls back to repo-only boundary when WORKTREES_BASE is not set', () => {
    const loadDocs = loadModule(undefined); // no WORKTREES_BASE
    const result = loadDocs('READ_DOCS_ON_DEV', '../rules/ui.md', repoRoot);
    assert.equal(result, '', 'Without WORKTREES_BASE, paths outside repo should be rejected');
  });

  it('rejects absolute paths even with WORKTREES_BASE set', () => {
    const loadDocs = loadModule(worktreesBase);
    const absPath = path.join(worktreesBase, 'rules', 'ui.md');
    const result = loadDocs('READ_DOCS_ON_DEV', absPath, repoRoot);
    assert.equal(result, '', 'Absolute paths should always be rejected');
  });
});
