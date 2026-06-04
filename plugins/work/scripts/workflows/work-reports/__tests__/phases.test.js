'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const inputs = require('../lib/phases/inputs');
const collect = require('../lib/phases/collect_artifacts');
const summarize = require('../lib/phases/summarize');
const emit = require('../lib/phases/emit');

function makeTasksDir(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-phases-'));
  const tasksDir = path.join(root, 'tasks', 'ECHO-7777');
  fs.mkdirSync(tasksDir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(tasksDir, name), contents);
  }
  return { root, tasksDir };
}

test('inputs blocks when required artifacts missing', () => {
  const { root, tasksDir } = makeTasksDir({});
  const r = inputs.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('tests.check.md'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('inputs passes when all required artifacts present', () => {
  const { root, tasksDir } = makeTasksDir({
    'tests.check.md': 'Status: APPROVED',
    'code-review.check.md': 'Status: APPROVED',
    'completion.check.md': 'Status: COMPLETE',
  });
  const r = inputs.validate({ tasksDir });
  assert.equal(r.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('collect_artifacts indexes only matching artifacts', () => {
  const { root, tasksDir } = makeTasksDir({
    'brief.md': 'x',
    'random.txt': 'ignore me',
    'qa-feature.check.md': 'Status: APPROVED',
  });
  const r = collect.validate({ tasksDir, ticket: 'ECHO-7777' });
  assert.equal(r.ok, true);
  const ctx = JSON.parse(fs.readFileSync(path.join(tasksDir, 'reports-context.json'), 'utf8'));
  assert.ok(ctx.files.includes('brief.md'));
  assert.ok(ctx.files.includes('qa-feature.check.md'));
  assert.ok(!ctx.files.includes('random.txt'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('summarize extracts Status and flags BLOCKED', () => {
  const { root, tasksDir } = makeTasksDir({
    'reports-context.json': JSON.stringify({ files: ['a.check.md', 'b.check.md'] }),
    'a.check.md': '## x\nStatus: APPROVED\n',
    'b.check.md': '## y\nStatus: BLOCKED\n',
  });
  const r = summarize.validate({ tasksDir, ticket: 'ECHO-7777' });
  assert.equal(r.ok, true);
  assert.ok((r.warnings || []).some((w) => /BLOCKED/.test(w)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('emit blocks on missing required sections', () => {
  const { root, tasksDir } = makeTasksDir({
    'reports.md': '## Overview\nincomplete\nStatus: COMPLETE\n',
  });
  const r = emit.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('## QA') || r.errors[0].includes('missing section'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('emit passes when all sections + Status present', () => {
  const md = [
    '## Overview',
    'x',
    '## Brief / Spec / Tasks',
    'y',
    '## QA',
    'z',
    '## Code review',
    'a',
    '## Completion',
    'b',
    '## CI / Follow-up',
    'c',
    '',
    'Status: COMPLETE',
  ].join('\n');
  const { root, tasksDir } = makeTasksDir({ 'reports.md': md });
  const r = emit.validate({ tasksDir });
  assert.equal(r.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});
