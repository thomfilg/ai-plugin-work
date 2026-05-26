'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getKindCheckRegistry } = require('../lib/kind-checks/kind-registry');
const frontend = require('../lib/kind-checks/frontend');
const backend = require('../lib/kind-checks/backend');

function makeTasksDir({ tasks = '', qaReport = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-kind-'));
  const tasksDir = path.join(root, 'ECHO-7777');
  fs.mkdirSync(tasksDir, { recursive: true });
  if (tasks) fs.writeFileSync(path.join(tasksDir, 'tasks.md'), tasks);
  if (qaReport) fs.writeFileSync(path.join(tasksDir, 'qa-feature.check.md'), qaReport);
  return { root, tasksDir };
}

test('kind-registry exposes all six kinds', () => {
  const r = getKindCheckRegistry();
  for (const k of ['frontend', 'backend', 'wiring', 'e2e', 'devops', 'fullstack']) {
    assert.ok(r[k]);
    assert.equal(typeof r[k].appliesTo, 'function');
    assert.equal(typeof r[k].validate, 'function');
  }
});

test('frontend BLOCKS when QA section missing', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: '<!-- frontend -->',
    qaReport: '# QA\n\nNo kind sections here.\n',
  });
  const r = frontend.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('Frontend QA'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('frontend passes when all checklist items checked', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: '<!-- frontend -->',
    qaReport: [
      '# QA',
      '',
      '### Frontend QA',
      '- [x] Loading state shown',
      '- [x] Empty state shown',
      '- [x] Error state shown',
      '- [x] Success state shown',
      '',
    ].join('\n'),
  });
  const r = frontend.validate({ tasksDir });
  assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('frontend BLOCKS when checklist has unchecked items', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: '<!-- frontend -->',
    qaReport: ['### Frontend QA', '- [x] Loading state shown', '- [ ] Empty state shown', ''].join(
      '\n'
    ),
  });
  const r = frontend.validate({ tasksDir });
  assert.equal(r.ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('backend BLOCKS when Backend QA section missing', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: '<!-- backend -->',
    qaReport: '# QA\n\nNothing here.\n',
  });
  const r = backend.validate({ tasksDir });
  assert.equal(r.ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});
