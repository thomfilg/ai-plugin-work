'use strict';

/**
 * Live-collector integration test (GH-755): a real tiny git repo proves the
 * whole retroactive-red mechanism — derive tests from the diff, run them on
 * head (pass), overlay them onto a base worktree and run there (fail) — and
 * the engine turns those observations into VERIFIED. Plus the two flagship
 * failure shapes: an empty diff (CONTRADICTED) and a tautology test that
 * passes on base (UNVERIFIED + flag).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildObservations } = require('../observe');
const { resolveTaskBaseRef, observeBoundary } = require('../boundary');
const { evaluate } = require('../verdict-engine');
const { reapBaseWorktree } = require('../collect/base-worktree');
const { VERDICTS } = require('../../lib/outcome-verdicts');

let ROOT;
let REPO;
let BASE_WT;
let baseSha;

function git(args) {
  return execFileSync('git', ['-C', REPO, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(rel, content) {
  const full = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'task-verify-live-'));
  REPO = path.join(ROOT, 'repo');
  BASE_WT = path.join(ROOT, 'base-wt');
  fs.mkdirSync(REPO);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);

  // Base commit: a buggy module, a node --test package, no tests yet.
  write('package.json', JSON.stringify({ name: 't', scripts: { test: 'node --test' } }));
  write('src/math.js', 'module.exports = { add: (a, b) => a - b };\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base: buggy add']);
  baseSha = git(['rev-parse', 'HEAD']);

  // Task commit: fix the bug + author the test (a genuine TDD outcome).
  write('src/math.js', 'module.exports = { add: (a, b) => a + b };\n');
  write(
    'src/__tests__/math.test.js',
    [
      "const { test } = require('node:test');",
      "const assert = require('node:assert/strict');",
      "const { add } = require('../math.js');",
      "test('add adds', () => { assert.equal(add(2, 2), 4); });",
      '',
    ].join('\n')
  );
  git(['add', '-A']);
  git(['commit', '-qm', 'task 1: fix add with test']);
});

after(() => {
  reapBaseWorktree({ repoDir: REPO, dir: BASE_WT });
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('task-verify live collectors (GH-755)', () => {
  it('real work: fail-on-base + pass-on-head observed from a real repo → VERIFIED', () => {
    const obs = buildObservations({
      repoDir: REPO,
      baseRef: baseSha,
      scopeGlobs: ['src/**'],
      taskKind: 'tdd-code',
      baseWorktreeDir: BASE_WT,
    });

    assert.equal(obs.diff.empty, false);
    assert.deepEqual(obs.derivedTests.files, ['src/__tests__/math.test.js']);
    assert.equal(obs.headRun.outcome, 'pass');
    assert.equal(obs.headRun.reporterKind, 'structured');
    assert.ok(obs.headRun.testsRan >= 1);
    assert.equal(obs.baseRun.outcome, 'fail', 'overlaid test must fail on the base worktree');

    const verdict = evaluate(obs, 'tdd-code');
    assert.equal(verdict.verdict, VERDICTS.verified, verdict.reasons.join(' | '));
  });

  it('an empty boundary (no commits) is CONTRADICTED with a retry exit', () => {
    const head = git(['rev-parse', 'HEAD']);
    const obs = buildObservations({
      repoDir: REPO,
      baseRef: head, // base == head → empty diff
      scopeGlobs: ['src/**'],
      taskKind: 'tdd-code',
      baseWorktreeDir: BASE_WT,
    });
    const verdict = evaluate(obs, 'tdd-code');
    assert.equal(verdict.verdict, VERDICTS.contradicted);
    assert.ok(verdict.violatedInvariants.includes('I1'));
    assert.equal(verdict.exit, 'retry');
  });

  it('a tautology test (passes on base too) advances with the tautology flag', () => {
    // New task: a change-detector test asserting existing behavior only.
    write(
      'src/__tests__/tautology.test.js',
      [
        "const { test } = require('node:test');",
        "const assert = require('node:assert/strict');",
        "test('always true', () => { assert.equal(1, 1); });",
        '',
      ].join('\n')
    );
    git(['add', '-A']);
    git(['commit', '-qm', 'task 2: tautology test']);
    const prevHead = git(['rev-parse', 'HEAD~1']);

    const obs = buildObservations({
      repoDir: REPO,
      baseRef: prevHead,
      scopeGlobs: ['src/**'],
      taskKind: 'tdd-code',
      baseWorktreeDir: BASE_WT,
    });
    assert.equal(obs.baseRun.outcome, 'pass');

    const verdict = evaluate(obs, 'tdd-code');
    assert.equal(verdict.verdict, VERDICTS.unverified);
    assert.ok(verdict.flags.includes('tautology'), verdict.flags.join(','));
  });

  it('unresolvable scope degrades to a flag, never a block', () => {
    const obs = buildObservations({
      repoDir: REPO,
      baseRef: baseSha,
      scopeGlobs: null,
      taskKind: 'tdd-code',
      baseWorktreeDir: BASE_WT,
    });
    assert.equal(obs.diff.scopeUnresolved, true);
    const verdict = evaluate(obs, 'tdd-code');
    assert.equal(verdict.verdict, VERDICTS.unverified);
    assert.ok(verdict.flags.includes('scope-resolution-failed'));
  });

  it('bookkeeping SHA that does not resolve in repoDir is a mechanism failure, not a foreign merge-base', () => {
    // A tasksDir whose .last-commit-sha belongs to a DIFFERENT repository:
    // resolveTaskBaseRef must return null (repo-identity mismatch) so
    // observeBoundary reports an error instead of measuring this repo.
    const tasksDir = path.join(ROOT, 'tasks-foreign');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, '.last-commit-sha'),
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n'
    );

    assert.equal(resolveTaskBaseRef(REPO, tasksDir), null);
    const boundary = observeBoundary({ repoDir: REPO, tasksDir, taskNum: 1, taskType: 'tdd-code' });
    assert.ok(boundary.error, 'expected a mechanism-failure error');
  });

  it('bookkeeping SHA that resolves in repoDir is used as the base ref', () => {
    const tasksDir = path.join(ROOT, 'tasks-own');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, '.last-commit-sha'), `${baseSha}\n`);
    assert.equal(resolveTaskBaseRef(REPO, tasksDir), baseSha);
  });
});
