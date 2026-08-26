'use strict';

/**
 * base-branch-candidates.test.js
 *
 * The boundary's merge-base fallback used to be `env.BASE_BRANCH || 'main'`,
 * tried as `origin/<base>` then `<base>`. On a dev-based repo with no
 * BASE_BRANCH exported, BOTH refs fail to resolve, resolveTaskBaseRef returns
 * null, and observeBoundary reports a mechanism failure — which the outcome
 * gate advances past with a `runner-unknown` flag. Every task on such a repo
 * can reach `completed` without the verifier having measured anything.
 *
 * The candidates now come from the canonical resolver
 * (config.getDiffBaseCandidates: BASE_BRANCH → origin/HEAD symbolic-ref →
 * probe main/dev/master), the same list the check-step scope diffs use.
 *
 * Run: node --test workflows/task-verify/__tests__/base-branch-candidates.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { baseBranchCandidates, resolveTaskBaseRef } = require('../boundary');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A repo whose only branch is `dev`, with an `origin/dev` remote ref. */
function makeDevRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'base-branch-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '--bare', '--initial-branch=dev', origin]);
  execFileSync('git', ['init', '--initial-branch=dev', work]);
  git(work, ['config', 'user.email', 't@example.com']);
  git(work, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'base']);
  git(work, ['remote', 'add', 'origin', origin]);
  git(work, ['push', '-u', 'origin', 'dev']);
  const baseSha = git(work, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(work, 'b.txt'), 'two\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'task work']);
  return { root, work, baseSha };
}

describe('task-verify boundary: base-branch candidates', () => {
  it('honours an injected BASE_BRANCH', () => {
    assert.deepEqual(baseBranchCandidates(process.cwd(), { BASE_BRANCH: 'dev' }), [
      'origin/dev',
      'dev',
    ]);
  });

  it('strips a redundant origin/ prefix', () => {
    assert.deepEqual(baseBranchCandidates(process.cwd(), { BASE_BRANCH: 'origin/release' }), [
      'origin/release',
      'release',
    ]);
  });

  it('resolves a base ref on a dev-based repo with no BASE_BRANCH set', () => {
    const repo = makeDevRepo();
    try {
      const tasksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-branch-tasks-'));
      // No .last-commit-sha → the merge-base fallback is the only path, and
      // with a hardcoded `main` it returned null here (mechanism failure).
      const resolved = resolveTaskBaseRef(repo.work, tasksDir, {});
      assert.equal(resolved, repo.baseSha);
      fs.rmSync(tasksDir, { recursive: true, force: true });
    } finally {
      fs.rmSync(repo.root, { recursive: true, force: true });
    }
  });
});
