/**
 * Tests for check2/lib/changed-specs.js (GH-394, echo-5224):
 * the reliability sweep must be scoped to actually-changed spec files
 * (git diff origin/BASE...HEAD), keeping unchanged-but-required specs that
 * import a changed helper, and noting skipped same-directory siblings.
 *
 * Uses a real temp git repo with an origin/main ref.
 */

'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { computeChangedSpecs, resolveBaseRef, buildE2eEnv } = require('../lib/changed-specs');

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

function write(repo, rel, content) {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

let repo;
let originalCwd;
let originalBaseBranch;

before(() => {
  originalCwd = process.cwd();
  originalBaseBranch = process.env.BASE_BRANCH;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'changed-specs-test-'));

  sh('git init -q -b main', repo);

  // Base state: two admin sibling specs, one home spec importing a helper.
  write(repo, 'tests/e2e/specs/admin/user-details-a.spec.ts', "test('a', () => {});\n");
  write(repo, 'tests/e2e/specs/admin/user-details-b.spec.ts', "test('b', () => {});\n");
  write(
    repo,
    'tests/e2e/specs/home/favorites.spec.ts',
    "import { seedFavorites } from '../../helpers/seed-favorites';\ntest('c', () => {});\n"
  );
  write(repo, 'tests/e2e/helpers/seed-favorites.ts', 'export const seedFavorites = 1;\n');
  write(repo, 'README.md', 'hi\n');
  sh('git add -A && git commit -q -m base', repo);
  // Simulate the remote base branch.
  sh('git update-ref refs/remotes/origin/main HEAD', repo);

  // Branch work: change ONE admin spec and the helper the home spec imports.
  sh('git checkout -q -b feature', repo);
  write(repo, 'tests/e2e/specs/admin/user-details-a.spec.ts', "test('a changed', () => {});\n");
  write(repo, 'tests/e2e/helpers/seed-favorites.ts', 'export const seedFavorites = 2;\n');
  sh('git add -A && git commit -q -m change', repo);

  process.chdir(repo);
  process.env.BASE_BRANCH = 'main';
});

after(() => {
  process.chdir(originalCwd);
  if (originalBaseBranch === undefined) delete process.env.BASE_BRANCH;
  else process.env.BASE_BRANCH = originalBaseBranch;
  fs.rmSync(repo, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.CHECK_E2E_SPEC_TIMEOUT_MS;
});
afterEach(() => {
  delete process.env.CHECK_E2E_SPEC_TIMEOUT_MS;
});

describe('resolveBaseRef', () => {
  it('resolves origin/<BASE_BRANCH>', () => {
    assert.equal(resolveBaseRef(), 'origin/main');
  });
});

describe('computeChangedSpecs', () => {
  it('includes strictly-changed specs, NOT unchanged same-directory siblings', () => {
    const scoped = computeChangedSpecs();
    assert.equal(scoped.baseRef, 'origin/main');
    assert.deepEqual(scoped.changedSpecs, ['tests/e2e/specs/admin/user-details-a.spec.ts']);
    assert.ok(!scoped.specs.includes('tests/e2e/specs/admin/user-details-b.spec.ts'));
  });

  it('keeps unchanged-but-required specs that import a changed helper', () => {
    const scoped = computeChangedSpecs();
    assert.deepEqual(scoped.keptImporters, ['tests/e2e/specs/home/favorites.spec.ts']);
    assert.ok(scoped.specs.includes('tests/e2e/specs/home/favorites.spec.ts'));
  });

  it('notes skipped siblings (what the old directory-pattern sweep would have run)', () => {
    const scoped = computeChangedSpecs();
    assert.deepEqual(scoped.skippedSiblings, ['tests/e2e/specs/admin/user-details-b.spec.ts']);
  });

  it('picks up uncommitted spec changes too', () => {
    write(repo, 'tests/e2e/specs/admin/user-details-b.spec.ts', "test('b dirty', () => {});\n");
    try {
      const scoped = computeChangedSpecs();
      assert.ok(scoped.specs.includes('tests/e2e/specs/admin/user-details-b.spec.ts'));
      assert.deepEqual(scoped.skippedSiblings, []);
    } finally {
      sh('git checkout -q -- tests/e2e/specs/admin/user-details-b.spec.ts', repo);
    }
  });
});

describe('buildE2eEnv', () => {
  it('exports newline-separated CHANGED_SPECS + base ref + default 60s per-spec budget', () => {
    const scoped = computeChangedSpecs();
    const env = buildE2eEnv(scoped);
    const specs = env.CHANGED_SPECS.split('\n');
    assert.ok(specs.includes('tests/e2e/specs/admin/user-details-a.spec.ts'));
    assert.ok(specs.includes('tests/e2e/specs/home/favorites.spec.ts'));
    assert.equal(specs.includes('tests/e2e/specs/admin/user-details-b.spec.ts'), false);
    assert.equal(env.CHANGED_SPECS_BASE, 'origin/main');
    assert.equal(env.E2E_PER_SPEC_TIMEOUT_MS, '60000');
  });

  it('honors CHECK_E2E_SPEC_TIMEOUT_MS (echo-5224: 30s too tight under --repeat-each)', () => {
    process.env.CHECK_E2E_SPEC_TIMEOUT_MS = '120000';
    const env = buildE2eEnv(computeChangedSpecs());
    assert.equal(env.E2E_PER_SPEC_TIMEOUT_MS, '120000');
  });

  it('omits CHANGED_SPECS when base is unresolvable (unscoped fallback)', () => {
    const env = buildE2eEnv({
      baseRef: null,
      specs: [],
      changedSpecs: [],
      keptImporters: [],
      skippedSiblings: [],
    });
    assert.equal(env.CHANGED_SPECS, undefined);
    assert.equal(typeof env.E2E_PER_SPEC_TIMEOUT_MS, 'string');
  });
});
