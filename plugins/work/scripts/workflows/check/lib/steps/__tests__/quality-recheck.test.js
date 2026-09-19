'use strict';

// GH-741 review (greptile P2): `7_quality_recheck` used to treat ANY
// `git status --porcelain` output as "code was modified" and re-ran the full
// quality gate. Since commit-and-push.js no longer runs a blanket
// `git add -A`, an in-repo TASKS_BASE leaves the workflow's own artifacts
// (`*.check.md` reports, state files) sitting uncommitted forever — which
// would re-trigger this step's expensive quality re-run on every /check
// traversal. The fix filters artifact-only paths out via
// `workflow-artifact-diff.js`, the same classifier already used elsewhere to
// break this exact self-invalidation loop.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const registerQualityRecheck = require('../quality-recheck');
const { porcelainPath } = registerQualityRecheck;
const runTests = require('../run-tests');

describe('quality-recheck — porcelainPath', () => {
  it('parses a plain modified/untracked entry', () => {
    assert.equal(porcelainPath(' M some/file.js'), 'some/file.js');
    assert.equal(porcelainPath('?? new/file.js'), 'new/file.js');
  });

  it('resolves a rename entry to the NEW path', () => {
    assert.equal(porcelainPath('R  old/name.js -> new/name.js'), 'new/name.js');
  });
});

describe('quality-recheck — 7_quality_recheck step (artifact-only filtering)', () => {
  let TMP;
  let REPO;
  let ORIG_CWD;
  let ORIG_TASKS_BASE;
  let calls;

  function sh(cmd) {
    return cp.execSync(cmd, { cwd: REPO, encoding: 'utf8' }).trim();
  }

  function runStep() {
    let handler;
    registerQualityRecheck((_id, fn) => {
      handler = fn;
    });
    return handler({}, { tasksDir: TMP });
  }

  before(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-recheck-'));
    REPO = path.join(TMP, 'repo');
    fs.mkdirSync(REPO);
    ORIG_CWD = process.cwd();
    cp.execSync('git init --initial-branch=main .', { cwd: REPO });
    cp.execSync('git config user.email "test@example.com"', { cwd: REPO });
    cp.execSync('git config user.name "Test"', { cwd: REPO });
    fs.writeFileSync(path.join(REPO, 'base.txt'), 'base\n');
    cp.execSync('git add base.txt', { cwd: REPO });
    cp.execSync('git commit -m base', { cwd: REPO });
    process.chdir(REPO);
  });

  after(() => {
    process.chdir(ORIG_CWD);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    ORIG_TASKS_BASE = process.env.TASKS_BASE;
    calls = 0;
    runTests.runQualityGate = () => {
      calls++;
      return { output: 'pass 1 fail 0', exitCode: 0, tier: 'stub' };
    };
  });

  afterEach(() => {
    if (ORIG_TASKS_BASE === undefined) delete process.env.TASKS_BASE;
    else process.env.TASKS_BASE = ORIG_TASKS_BASE;
    delete require.cache[require.resolve('../../../../lib/config')];
    sh('git clean -fdx').trim();
    // Restore base.txt if a test touched it.
    fs.writeFileSync(path.join(REPO, 'base.txt'), 'base\n');
    try {
      sh('git checkout -- base.txt');
    } catch {
      /* nothing staged/tracked to revert */
    }
  });

  it('skips the quality gate when only an in-repo TASKS_BASE artifact is uncommitted', () => {
    process.env.TASKS_BASE = path.join(REPO, 'tasks');
    delete require.cache[require.resolve('../../../../lib/config')];
    fs.mkdirSync(path.join(REPO, 'tasks', 'GH-1'), { recursive: true });
    fs.writeFileSync(path.join(REPO, 'tasks', 'GH-1', 'recheck.check.md'), 'report\n');

    const result = runStep();

    assert.equal(result, null);
    assert.equal(calls, 0, 'the quality gate must not run for artifact-only changes');
  });

  it('still runs the quality gate when a real source file is uncommitted', () => {
    delete process.env.TASKS_BASE;
    delete require.cache[require.resolve('../../../../lib/config')];
    fs.writeFileSync(path.join(REPO, 'base.txt'), 'changed\n');

    runStep();

    assert.equal(calls, 1, 'a real code change must still trigger the quality gate');
  });
});
