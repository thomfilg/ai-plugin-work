/**
 * Tests for impact-aware unit-test selection (echo-5820-3):
 * check2's affected tier is changed-files-only, so api-contract changes miss
 * consumer-test breakage. computeImpactTests adds the one-hop set — test
 * files that import (reference the basename stem of) any changed source
 * file — exported to SCRIPT_RUN_AFFECTED_UNIT as IMPACT_TEST_FILES.
 * Default on; CHECK_IMPACT_TESTS=0 disables.
 *
 * Uses a real temp git repo with an origin/main ref.
 */

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { computeImpactTests, buildUnitEnv, impactTestsEnabled } = require('../lib/changed-specs');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(base, rel, content) {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

let repo;
let originalBaseBranch;
let originalImpactFlag;

before(() => {
  originalBaseBranch = process.env.BASE_BRANCH;
  originalImpactFlag = process.env.CHECK_IMPACT_TESTS;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-tests-'));

  sh('git init -q -b main', repo);

  // Base state: a hook, a consumer test that imports it, an unrelated test,
  // and the hook's OWN colocated test (also imports it).
  write(repo, 'src/hooks/use-bulk-tabbed-views.ts', 'export const useBulkTabbedViews = () => 1;\n');
  write(
    repo,
    'src/components/__tests__/grid.test.tsx',
    "import { useBulkTabbedViews } from '../../hooks/use-bulk-tabbed-views';\ntest('grid', () => {});\n"
  );
  write(
    repo,
    'src/hooks/use-bulk-tabbed-views.test.ts',
    "import { useBulkTabbedViews } from './use-bulk-tabbed-views';\ntest('hook', () => {});\n"
  );
  write(repo, 'src/other/unrelated.test.ts', "test('unrelated', () => {});\n");
  sh('git add -A && git commit -q -m base', repo);
  sh('git update-ref refs/remotes/origin/main HEAD', repo);

  // Branch work: change the hook's contract (source only — no tests touched).
  sh('git checkout -q -b feature', repo);
  write(
    repo,
    'src/hooks/use-bulk-tabbed-views.ts',
    'export const useBulkTabbedViewsMany = () => 2;\n'
  );
  sh('git add -A && git commit -q -m contract-change', repo);

  process.env.BASE_BRANCH = 'main';
});

after(() => {
  if (originalBaseBranch === undefined) delete process.env.BASE_BRANCH;
  else process.env.BASE_BRANCH = originalBaseBranch;
  if (originalImpactFlag === undefined) delete process.env.CHECK_IMPACT_TESTS;
  else process.env.CHECK_IMPACT_TESTS = originalImpactFlag;
  fs.rmSync(repo, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.CHECK_IMPACT_TESTS;
});

describe('computeImpactTests (one import hop)', () => {
  it('finds test files that import a changed source file', () => {
    const impact = computeImpactTests(repo);
    assert.equal(impact.enabled, true);
    assert.equal(impact.baseRef, 'origin/main');
    assert.deepEqual(impact.scannedSources, ['src/hooks/use-bulk-tabbed-views.ts']);
    assert.deepEqual(impact.impactTests.sort(), [
      'src/components/__tests__/grid.test.tsx',
      'src/hooks/use-bulk-tabbed-views.test.ts',
    ]);
    assert.ok(
      !impact.impactTests.includes('src/other/unrelated.test.ts'),
      'unrelated test must not be swept in'
    );
  });

  it('is disabled via CHECK_IMPACT_TESTS=0 (env gate off)', () => {
    process.env.CHECK_IMPACT_TESTS = '0';
    assert.equal(impactTestsEnabled(), false);
    const impact = computeImpactTests(repo);
    assert.deepEqual(impact, {
      enabled: false,
      baseRef: null,
      impactTests: [],
      scannedSources: [],
    });
    assert.equal(buildUnitEnv(impact), undefined);
  });

  it('defaults to enabled when the env var is unset', () => {
    assert.equal(impactTestsEnabled(), true);
  });
});

describe('buildUnitEnv (SCRIPT_RUN_AFFECTED_UNIT contract)', () => {
  it('exports IMPACT_TEST_FILES (newline-separated) and the base ref', () => {
    const env = buildUnitEnv(computeImpactTests(repo));
    assert.ok(env, 'env additions expected');
    const files = env.IMPACT_TEST_FILES.split('\n').sort();
    assert.deepEqual(files, [
      'src/components/__tests__/grid.test.tsx',
      'src/hooks/use-bulk-tabbed-views.test.ts',
    ]);
    assert.equal(env.IMPACT_TEST_FILES_BASE, 'origin/main');
  });

  it('returns undefined when the impact set is empty (suite runs unchanged)', () => {
    assert.equal(
      buildUnitEnv({ enabled: true, baseRef: 'origin/main', impactTests: [], scannedSources: [] }),
      undefined
    );
    assert.equal(buildUnitEnv(null), undefined);
  });
});
