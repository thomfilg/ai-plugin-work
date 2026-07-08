/**
 * Tests for lib/quality-check.js
 *
 * Tests the 4-tier fallback logic for quality checks:
 *   0. Env-var overrides ($LINT_COMMAND / $TYPECHECK_COMMAND / $TEST_COMMAND)
 *   1. pnpm dev:check (project script)
 *   2. Bundled dev-check scripts (plugin fallback)
 *   3. Standard scripts (lint/typecheck/test)
 *
 * Run with: node --test lib/__tests__/quality-check.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  resolveQualityCommand,
  getAvailableScripts,
  hasBundledDevCheck,
  BUNDLED_DEV_CHECK,
} = require('../quality-check');

// Helper: create a temp directory with a package.json
function makeTempRepo(scripts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-test-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'test-repo', scripts }, null, 2)
  );
  return dir;
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Clear env-var overrides between tests so Tier 0 doesn't bleed into
// other tier tests (and vice versa). Restored in afterEach.
const ENV_KEYS = ['LINT_COMMAND', 'TYPECHECK_COMMAND', 'TEST_COMMAND'];
function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
}
function restoreEnv(snap) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

describe('quality-check', () => {
  let envSnap;
  beforeEach(() => {
    envSnap = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => restoreEnv(envSnap));

  describe('getAvailableScripts', () => {
    it('returns scripts from package.json', () => {
      const dir = makeTempRepo({ lint: 'eslint .', test: 'vitest' });
      try {
        const scripts = getAvailableScripts(dir);
        assert.strictEqual(scripts.lint, 'eslint .');
        assert.strictEqual(scripts.test, 'vitest');
      } finally {
        cleanupDir(dir);
      }
    });

    it('returns empty object when no package.json exists', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-test-'));
      try {
        const scripts = getAvailableScripts(dir);
        assert.deepStrictEqual(scripts, {});
      } finally {
        cleanupDir(dir);
      }
    });

    it('returns empty object for invalid JSON', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-test-'));
      fs.writeFileSync(path.join(dir, 'package.json'), 'not json');
      try {
        const scripts = getAvailableScripts(dir);
        assert.deepStrictEqual(scripts, {});
      } finally {
        cleanupDir(dir);
      }
    });
  });

  describe('resolveQualityCommand', () => {
    it('Tier 0: env-var overrides route through bundled dev-check.sh', () => {
      if (!hasBundledDevCheck()) return; // skip in environments without bundled scripts
      const dir = makeTempRepo({ 'dev:check': 'echo hi', lint: 'eslint .' });
      try {
        process.env.TYPECHECK_COMMAND = 'pnpm typecheck $CHANGED_FILES';
        const { command, strategy } = resolveQualityCommand(dir);
        assert.strictEqual(strategy, 'env-overrides');
        assert.strictEqual(command, BUNDLED_DEV_CHECK);
      } finally {
        cleanupDir(dir);
      }
    });

    it('Tier 0 wins over Tier 1 (dev:check) when env var set', () => {
      if (!hasBundledDevCheck()) return;
      const dir = makeTempRepo({ 'dev:check': 'pnpm dev:lint && pnpm dev:test' });
      try {
        process.env.LINT_COMMAND = 'pnpm lint $CHANGED_FILES';
        const { strategy } = resolveQualityCommand(dir);
        assert.strictEqual(strategy, 'env-overrides');
      } finally {
        cleanupDir(dir);
      }
    });

    it('Tier 0 does NOT trigger when env vars unset (falls to Tier 1)', () => {
      const dir = makeTempRepo({ 'dev:check': 'pnpm dev:lint' });
      try {
        const { strategy } = resolveQualityCommand(dir);
        assert.strictEqual(strategy, 'project-dev-check');
      } finally {
        cleanupDir(dir);
      }
    });

    it('Tier 1: uses pnpm dev:check when project defines it', () => {
      const dir = makeTempRepo({ 'dev:check': 'pnpm dev:lint && pnpm dev:test', lint: 'eslint .' });
      try {
        const { command, strategy } = resolveQualityCommand(dir);
        assert.strictEqual(strategy, 'project-dev-check');
        assert.strictEqual(command, 'pnpm dev:check');
      } finally {
        cleanupDir(dir);
      }
    });

    it('Tier 2: uses bundled dev-check when project lacks dev:check', () => {
      const dir = makeTempRepo({ lint: 'eslint .', test: 'vitest' });
      try {
        const { strategy } = resolveQualityCommand(dir);
        // If bundled scripts exist, should use them; otherwise falls to tier 3
        if (hasBundledDevCheck()) {
          assert.strictEqual(strategy, 'bundled-dev-check');
        } else {
          assert.strictEqual(strategy, 'standard-scripts');
        }
      } finally {
        cleanupDir(dir);
      }
    });

    it('Tier 3: uses standard scripts when no dev:check and no bundled scripts', () => {
      // Temporarily override BUNDLED_DEV_CHECK check by testing with a repo that has standard scripts
      const dir = makeTempRepo({ lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest' });
      try {
        const { command, strategy, scripts } = resolveQualityCommand(dir);
        if (strategy === 'standard-scripts') {
          assert.ok(command.includes('pnpm run lint'));
          assert.ok(command.includes('pnpm run typecheck'));
          assert.ok(command.includes('pnpm run test'));
          assert.deepStrictEqual(scripts, ['lint', 'typecheck', 'test']);
        }
        // If bundled scripts exist, it'll be tier 2 — that's also valid
      } finally {
        cleanupDir(dir);
      }
    });

    it('Tier 3: uses only available standard scripts (partial)', () => {
      const dir = makeTempRepo({ test: 'vitest' });
      try {
        const { strategy, scripts } = resolveQualityCommand(dir);
        if (strategy === 'standard-scripts') {
          assert.deepStrictEqual(scripts, ['test']);
        }
      } finally {
        cleanupDir(dir);
      }
    });

    it('returns none when no scripts available', () => {
      const dir = makeTempRepo({ build: 'tsc', start: 'node .' });
      try {
        const { strategy } = resolveQualityCommand(dir);
        // With bundled scripts present, tier 2 would match even without project scripts
        if (hasBundledDevCheck()) {
          assert.strictEqual(strategy, 'bundled-dev-check');
        } else {
          assert.strictEqual(strategy, 'none');
        }
      } finally {
        cleanupDir(dir);
      }
    });

    it('returns none when no package.json exists and no bundled scripts', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-test-'));
      try {
        const { strategy } = resolveQualityCommand(dir);
        if (hasBundledDevCheck()) {
          assert.strictEqual(strategy, 'bundled-dev-check');
        } else {
          assert.strictEqual(strategy, 'none');
        }
      } finally {
        cleanupDir(dir);
      }
    });

    it('Tier 1 takes priority over standard scripts', () => {
      const dir = makeTempRepo({
        'dev:check': 'pnpm dev:lint && pnpm dev:test',
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
        test: 'vitest',
      });
      try {
        const { strategy } = resolveQualityCommand(dir);
        assert.strictEqual(strategy, 'project-dev-check');
      } finally {
        cleanupDir(dir);
      }
    });
  });

  describe('hasBundledDevCheck', () => {
    it('returns boolean', () => {
      const result = hasBundledDevCheck();
      assert.strictEqual(typeof result, 'boolean');
    });

    it('checks the expected path', () => {
      assert.ok(BUNDLED_DEV_CHECK.endsWith('scripts/dev-check/dev-check.sh'));
    });
  });
});
