/**
 * Tests for scope-detect.js — detectScope() function.
 *
 * Derives a conventional-commit scope from a list of changed file paths.
 * These tests are RED scaffolds — scope-detect.js does not exist yet (Task 2).
 *
 * Run: node --test workflows/lib/__tests__/scope-detect.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectScope } = require('../scope-detect');

describe('scope-detect — detectScope()', () => {
  it('returns scope for single-directory changes', () => {
    const scope = detectScope([
      'scripts/workflows/lib/hooks/enforce-dev-commands.js',
      'scripts/workflows/lib/hooks/enforce-dev-commands.test.js',
    ]);
    assert.strictEqual(scope, 'hooks');
  });

  it('returns empty string for cross-cutting changes', () => {
    const scope = detectScope([
      'agents/commit-writer.md',
      'scripts/workflows/lib/scope-detect.js',
      'hooks/hooks.json',
    ]);
    assert.strictEqual(scope, '');
  });

  it('returns empty string for empty input', () => {
    assert.strictEqual(detectScope([]), '');
  });

  it('handles monorepo packages/ paths', () => {
    const scope = detectScope(['packages/auth/src/login.ts', 'packages/auth/src/logout.ts']);
    assert.strictEqual(scope, 'auth');
  });

  it('handles root-level files', () => {
    const scope = detectScope(['package.json', 'README.md']);
    assert.strictEqual(scope, '');
  });
});
