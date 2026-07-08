'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getCurrentTaskId } = require('../lib/ticket-id.js');

/**
 * Build an injectable git-branch exec stub that returns a fixed branch name.
 * The synapsys-local resolver reads the branch via an injectable exec so the
 * unit test never shells out to a real git repo.
 */
function branchExec(branch) {
  return () => branch;
}

test('getCurrentTaskId resolves GH-N from the cwd basename', () => {
  const id = getCurrentTaskId('/home/dev/p/tabwoah-GH-519', {
    exec: branchExec(''),
    env: {},
  });
  assert.equal(id, 'GH-519');
});

test('getCurrentTaskId resolves PROJ-N from an injected branch name', () => {
  const id = getCurrentTaskId('/home/dev/p/some-worktree', {
    exec: branchExec('feature/PROJ-123-add-thing'),
    env: {},
  });
  assert.equal(id, 'PROJ-123');
});

test('getCurrentTaskId branch GH-N takes precedence and normalizes to GH-N', () => {
  const id = getCurrentTaskId('/home/dev/p/plain-dir', {
    exec: branchExec('GH-42-fix-bug'),
    env: {},
  });
  assert.equal(id, 'GH-42');
});

test('getCurrentTaskId returns a falsy value for an unmatchable cwd and branch', () => {
  const id = getCurrentTaskId('/home/dev/p/plain-dir', {
    exec: branchExec('main'),
    env: {},
  });
  assert.ok(!id, `expected falsy, got ${JSON.stringify(id)}`);
});

test('getCurrentTaskId does not throw when the injected exec throws', () => {
  const throwingExec = () => {
    throw new Error('not a git repo');
  };
  assert.doesNotThrow(() => {
    const id = getCurrentTaskId('/home/dev/p/tabwoah-GH-7', {
      exec: throwingExec,
      env: {},
    });
    assert.equal(id, 'GH-7');
  });
});
