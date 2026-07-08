'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wait_merge = require('../lib/phases/wait_merge');

function makeCtx({ prContext = { prNumber: 1740 } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-waitmerge-'));
  const tasksDir = path.join(root, 'tasks', 'ECHO-7777');
  fs.mkdirSync(tasksDir, { recursive: true });
  if (prContext) {
    fs.writeFileSync(path.join(tasksDir, 'ci-context.json'), JSON.stringify(prContext));
  }
  return { root, tasksDir, worktreeRoot: root, ticket: 'ECHO-7777' };
}

test('wait_merge blocks when ci-context.json is missing', () => {
  const { root, tasksDir, worktreeRoot } = makeCtx({ prContext: null });
  const r = wait_merge.validate({ tasksDir, worktreeRoot, ticket: 'ECHO-7777' });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('ci-context.json'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('wait_merge advances when state=MERGED', () => {
  const original = wait_merge.fetchPrState;
  const ctx = makeCtx();
  // Monkey-patch the network call.
  wait_merge.fetchPrState = () => ({
    state: 'MERGED',
    mergedAt: '2026-05-19T18:00:00Z',
    mergeCommit: { oid: 'deadbeef' },
  });
  try {
    const r = wait_merge.validate(ctx);
    assert.equal(r.ok, true);
    assert.ok(r.summary.includes('merged'));
  } finally {
    wait_merge.fetchPrState = original;
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('wait_merge WAITS when state=OPEN (no errors, no advance)', () => {
  const original = wait_merge.fetchPrState;
  const ctx = makeCtx();
  wait_merge.fetchPrState = () => ({ state: 'OPEN', mergedAt: null, mergeCommit: null });
  try {
    const r = wait_merge.validate(ctx);
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, []);
    assert.ok(r.summary.includes('waiting for merge'));
  } finally {
    wait_merge.fetchPrState = original;
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('wait_merge BLOCKS when state=CLOSED (errors, no advance)', () => {
  const original = wait_merge.fetchPrState;
  const ctx = makeCtx();
  wait_merge.fetchPrState = () => ({ state: 'CLOSED', mergedAt: null, mergeCommit: null });
  try {
    const r = wait_merge.validate(ctx);
    assert.equal(r.ok, false);
    assert.ok(r.errors[0].includes('CLOSED'));
  } finally {
    wait_merge.fetchPrState = original;
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});
