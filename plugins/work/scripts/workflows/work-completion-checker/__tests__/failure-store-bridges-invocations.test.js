'use strict';

/**
 * Bug 1 regression guard:
 *   create-phase-runner builds a fresh `ctx` per invocation, so failures
 *   pushed by an enforcement phase MUST survive on disk to be folded into
 *   completion-verdict.json when report.js runs in a later invocation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/failure-store');
const report = require('../lib/phases/report');

function mkTasksDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gh282-failure-store-'));
  const tasksDir = path.join(root, 'GH-282');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(
    path.join(tasksDir, 'completion.check.md'),
    [
      '## Requirements Verification',
      '### Original Request:',
      'x',
      '### Deliverables Checklist:',
      '- [x] R1 - DELIVERED',
      '### Final Status:',
      '[COMPLETE]',
      '',
    ].join('\n'),
  );
  return { root, tasksDir };
}

test('report.buildVerdictDocument folds persisted failures with empty ctx.failures', () => {
  const { root, tasksDir } = mkTasksDir();
  try {
    // Simulate an earlier phase invocation that persisted a failure.
    store.appendForCheckType(
      tasksDir,
      'reuse_audit',
      [
        {
          requirementId: 'REUSE-1',
          checkType: 'reuse_audit',
          expected: 'Foo imported',
          observed: 'Bar imported instead',
        },
      ],
      { reuseChecked: 1 },
    );
    // Later invocation: fresh ctx, ctx.failures is empty.
    report.validate({ ticket: 'GH-282', tasksDir, failures: [] });
    const doc = JSON.parse(
      fs.readFileSync(path.join(tasksDir, 'completion-verdict.json'), 'utf8'),
    );
    assert.equal(doc.ok, false, 'verdict must be ok:false because store has a failure');
    assert.equal(doc.failures.length, 1);
    assert.equal(doc.failures[0].requirementId, 'REUSE-1');
    assert.equal(doc.summary.reuseChecked, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resetStore at inputs phase clears previously persisted failures', () => {
  const { root, tasksDir } = mkTasksDir();
  try {
    store.appendForCheckType(
      tasksDir,
      'reuse_audit',
      [
        {
          requirementId: 'REUSE-1',
          checkType: 'reuse_audit',
          expected: 'x',
          observed: 'y',
        },
      ],
      { reuseChecked: 1 },
    );
    store.resetStore(tasksDir);
    const state = store.readState(tasksDir);
    assert.deepEqual(state.failures, []);
    assert.deepEqual(state.summary, { reuseChecked: 0, scopeChecked: 0, testsChecked: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('appendForCheckType replaces records of the same checkType on re-run', () => {
  const { root, tasksDir } = mkTasksDir();
  try {
    store.appendForCheckType(
      tasksDir,
      'suggested_scope',
      [
        {
          requirementId: 'R2',
          checkType: 'suggested_scope',
          expected: 'a',
          observed: 'b',
        },
      ],
      { scopeChecked: 1 },
    );
    // Re-run of the same phase replaces, not duplicates.
    store.appendForCheckType(
      tasksDir,
      'suggested_scope',
      [
        {
          requirementId: 'R2',
          checkType: 'suggested_scope',
          expected: 'c',
          observed: 'd',
        },
      ],
      { scopeChecked: 1 },
    );
    const state = store.readState(tasksDir);
    assert.equal(state.failures.length, 1);
    assert.equal(state.failures[0].observed, 'd');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failures from store + ctx are deduped on exact match', () => {
  const { root, tasksDir } = mkTasksDir();
  try {
    const failure = {
      requirementId: 'REUSE-1',
      checkType: 'reuse_audit',
      expected: 'Foo imported',
      observed: 'not found in diff',
      file: undefined,
      line: 12,
    };
    store.appendForCheckType(tasksDir, 'reuse_audit', [failure], { reuseChecked: 1 });
    report.validate({ ticket: 'GH-282', tasksDir, failures: [failure] });
    const doc = JSON.parse(
      fs.readFileSync(path.join(tasksDir, 'completion-verdict.json'), 'utf8'),
    );
    assert.equal(doc.failures.length, 1, 'identical failure must be deduped');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
