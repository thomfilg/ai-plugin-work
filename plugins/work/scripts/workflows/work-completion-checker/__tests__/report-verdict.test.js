'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const report = require('../lib/phases/report');

function makeTasksDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-report-verdict-'));
  const tasksDir = path.join(root, 'GH-282');
  fs.mkdirSync(tasksDir, { recursive: true });
  // Seed a passing completion.check.md so report.validate doesn't bail early
  fs.writeFileSync(
    path.join(tasksDir, 'completion.check.md'),
    [
      '## Requirements Verification',
      '',
      '### Original Request:',
      'X',
      '',
      '### Deliverables Checklist:',
      '- [x] R1 - DELIVERED',
      '',
      '### Final Status:',
      '[COMPLETE]',
      '',
    ].join('\n'),
  );
  return { root, tasksDir };
}

test('completion-verdict.json artifact is persisted with structured failure records', () => {
  const { root, tasksDir } = makeTasksDir();
  const ctx = {
    ticket: 'GH-282',
    tasksDir,
    failures: [
      {
        requirementId: 'R1',
        checkType: 'reuse_audit',
        expected: 'ContentPageToolbar imported',
        observed: 'ExploreBulkToolbar imported instead',
      },
      {
        requirementId: 'R2',
        checkType: 'suggested_scope',
        expected: 'plugins/work/foo.js in diff',
        observed: 'missing from git diff --name-only',
      },
    ],
    summaryCounters: { reuseChecked: 1, scopeChecked: 1, testsChecked: 0 },
  };
  report.validate(ctx);
  const verdictPath = path.join(tasksDir, 'completion-verdict.json');
  assert.ok(fs.existsSync(verdictPath), 'completion-verdict.json must be written');
  const doc = JSON.parse(fs.readFileSync(verdictPath, 'utf8'));
  assert.equal(doc.ticket, 'GH-282');
  assert.equal(doc.ok, false);
  assert.equal(doc.failures.length, 2);
  assert.equal(doc.failures[0].checkType, 'reuse_audit');
  assert.equal(doc.failures[1].checkType, 'suggested_scope');
  assert.deepEqual(doc.summary, { reuseChecked: 1, scopeChecked: 1, testsChecked: 0 });
  // verdictAt ISO-8601
  assert.ok(!Number.isNaN(Date.parse(doc.verdictAt)));
  assert.equal(new Date(doc.verdictAt).toISOString(), doc.verdictAt);
  fs.rmSync(root, { recursive: true, force: true });
});

test('verdict summary reads ctx.{reuseAuditChecked,scopeChecked,testsChecked} when summaryCounters is absent (GS10)', () => {
  const { root, tasksDir } = makeTasksDir();
  const ctx = {
    ticket: 'GH-282',
    tasksDir,
    failures: [],
    reuseAuditChecked: 2,
    scopeChecked: 3,
    testsChecked: 4,
  };
  report.validate(ctx);
  const doc = JSON.parse(
    fs.readFileSync(path.join(tasksDir, 'completion-verdict.json'), 'utf8'),
  );
  assert.deepEqual(doc.summary, { reuseChecked: 2, scopeChecked: 3, testsChecked: 4 });
  fs.rmSync(root, { recursive: true, force: true });
});

test('verdict ok:true with empty failures when no records were pushed', () => {
  const { root, tasksDir } = makeTasksDir();
  const ctx = { ticket: 'GH-282', tasksDir, failures: [] };
  report.validate(ctx);
  const doc = JSON.parse(
    fs.readFileSync(path.join(tasksDir, 'completion-verdict.json'), 'utf8'),
  );
  assert.equal(doc.ok, true);
  assert.deepEqual(doc.failures, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('persistVerdict does not create completion.check.md when absent (Bug 5)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-report-absent-'));
  const tasksDir = path.join(root, 'GH-282');
  fs.mkdirSync(tasksDir, { recursive: true });
  const ctx = {
    ticket: 'GH-282',
    tasksDir,
    failures: [],
    summaryCounters: { reuseChecked: 0, scopeChecked: 0, testsChecked: 0 },
  };
  // Call validate (which invokes persistVerdict) — we don't care about its return.
  report.validate(ctx);
  assert.ok(
    fs.existsSync(path.join(tasksDir, 'completion-verdict.json')),
    'completion-verdict.json must still be written',
  );
  assert.equal(
    fs.existsSync(path.join(tasksDir, 'completion.check.md')),
    false,
    'completion.check.md must NOT be conjured into existence',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('report upserts Reuse/Scope/Test-pass verification section idempotently', () => {
  const { root, tasksDir } = makeTasksDir();
  const ctx = {
    ticket: 'GH-282',
    tasksDir,
    failures: [
      {
        requirementId: 'R1',
        checkType: 'reuse_audit',
        expected: 'Foo imported',
        observed: 'Bar imported',
      },
    ],
  };
  report.validate(ctx);
  report.validate(ctx);
  const text = fs.readFileSync(path.join(tasksDir, 'completion.check.md'), 'utf8');
  const header = '## Reuse / Scope / Test-pass verification';
  const occurrences = text.split(header).length - 1;
  assert.equal(occurrences, 1, 'verification section must be idempotent');
  assert.ok(text.includes('reuse_audit'), 'must include the failure checkType');
  fs.rmSync(root, { recursive: true, force: true });
});
