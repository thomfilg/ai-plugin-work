'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wait = require('../lib/phases/wait');
const triage = require('../lib/phases/triage');
const fixOrDoc = require('../lib/phases/fix_or_document');

function mk(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-phases-'));
  const tasksDir = path.join(root, 'ECHO-X');
  fs.mkdirSync(tasksDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(tasksDir, name), content);
  }
  return { root, tasksDir };
}

test('classifyChecks separates running, passed, failed', () => {
  const rollup = {
    statusCheckRollup: [
      { name: 'a', state: 'SUCCESS' },
      { name: 'b', state: 'IN_PROGRESS' },
      { name: 'c', state: 'FAILURE' },
      { name: 'd', state: 'COMPLETED' },
      { name: 'e', state: 'ERROR' },
    ],
  };
  const r = wait.classifyChecks(rollup);
  assert.equal(r.total, 5);
  assert.equal(r.running, 1);
  assert.equal(r.passed, 2);
  assert.equal(r.failures.length, 2);
});

test('triage auto-passes when ci-status.json has zero failures', () => {
  const { root, tasksDir } = mk({
    'ci-status.json': JSON.stringify({ failures: [] }),
  });
  const r = triage.validate({ tasksDir });
  assert.equal(r.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('triage BLOCKS when failures exist but no triage file', () => {
  const { root, tasksDir } = mk({
    'ci-status.json': JSON.stringify({ failures: [{ name: 'broken', state: 'FAILURE' }] }),
  });
  const r = triage.validate({ tasksDir });
  assert.equal(r.ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('triage BLOCKS on invalid category', () => {
  const { root, tasksDir } = mk({
    'ci-status.json': JSON.stringify({ failures: [{ name: 'broken', state: 'FAILURE' }] }),
    'ci-triage.json': JSON.stringify({
      classifications: [
        { name: 'broken', category: 'something-wrong', evidence: 'some evidence text' },
      ],
    }),
  });
  const r = triage.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /invalid category/.test(e)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('triage PASSES with valid classifications + evidence', () => {
  const { root, tasksDir } = mk({
    'ci-status.json': JSON.stringify({
      failures: [
        { name: 'broken', state: 'FAILURE' },
        { name: 'flaky-net', state: 'FAILURE' },
      ],
    }),
    'ci-triage.json': JSON.stringify({
      classifications: [
        { name: 'broken', category: 'regression', evidence: 'introduced by commit abc1234' },
        { name: 'flaky-net', category: 'flake', evidence: 'flaked 3 times on main this week' },
      ],
    }),
  });
  const r = triage.validate({ tasksDir });
  assert.equal(r.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('fix_or_document BLOCKS regression without fixCommitSha', () => {
  const { root, tasksDir } = mk({
    'ci-status.json': JSON.stringify({ failures: [{ name: 'broken', state: 'FAILURE' }] }),
    'ci-triage.json': JSON.stringify({
      classifications: [
        { name: 'broken', category: 'regression', evidence: 'this PR introduced it' },
      ],
    }),
  });
  const r = fixOrDoc.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /fixCommitSha/.test(e)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('fix_or_document BLOCKS pre-existing without documentation', () => {
  const { root, tasksDir } = mk({
    'ci-status.json': JSON.stringify({ failures: [{ name: 'old', state: 'FAILURE' }] }),
    'ci-triage.json': JSON.stringify({
      classifications: [{ name: 'old', category: 'pre-existing', evidence: 'fails on main too' }],
    }),
  });
  const r = fixOrDoc.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /documentation/.test(e)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('fix_or_document PASSES when fixes + docs are recorded', () => {
  const { root, tasksDir } = mk({
    'ci-status.json': JSON.stringify({
      failures: [
        { name: 'broken', state: 'FAILURE' },
        { name: 'old', state: 'FAILURE' },
      ],
    }),
    'ci-triage.json': JSON.stringify({
      classifications: [
        {
          name: 'broken',
          category: 'regression',
          evidence: 'introduced here',
          fixCommitSha: 'abc1234',
        },
        {
          name: 'old',
          category: 'pre-existing',
          evidence: 'fails on main',
          documentation: 'see issue #999',
        },
      ],
    }),
  });
  const r = fixOrDoc.validate({ tasksDir });
  assert.equal(r.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});
