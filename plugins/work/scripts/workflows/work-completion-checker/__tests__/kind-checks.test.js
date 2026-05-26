'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getKindCheckRegistry } = require('../lib/kind-checks/kind-registry');
const wiring = require('../lib/kind-checks/wiring');
const backend = require('../lib/kind-checks/backend');

function makeTasksDir({ brief = '', spec = '', tasks = '', prContext = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-kind-'));
  const tasksDir = path.join(root, 'ECHO-7777');
  fs.mkdirSync(tasksDir, { recursive: true });
  if (brief) fs.writeFileSync(path.join(tasksDir, 'brief.md'), brief);
  if (spec) fs.writeFileSync(path.join(tasksDir, 'spec.md'), spec);
  if (tasks) fs.writeFileSync(path.join(tasksDir, 'tasks.md'), tasks);
  if (prContext)
    fs.writeFileSync(path.join(tasksDir, 'pr-context.json'), JSON.stringify(prContext));
  return { root, tasksDir };
}

test('kind-registry exposes all six kinds', () => {
  const r = getKindCheckRegistry();
  for (const k of ['frontend', 'backend', 'wiring', 'e2e', 'devops', 'fullstack']) {
    assert.ok(r[k], `expected kind "${k}" in registry`);
    assert.equal(typeof r[k].appliesTo, 'function');
    assert.equal(typeof r[k].validate, 'function');
  }
});

test('wiring BLOCKS when diff contains backend files and brief forbids backend', () => {
  const { root, tasksDir } = makeTasksDir({
    brief: '# Brief\n\n**No backend changes** — sibling-owned.\n',
    tasks: '<!-- wiring -->',
    prContext: {
      base: 'origin/main',
      files: ['app/api/trpc/routers/explore.ts', 'components/Foo.tsx'],
    },
  });
  const r = wiring.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('app/api') || e.includes('ECHO-4579')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('wiring passes when diff has no backend files', () => {
  const { root, tasksDir } = makeTasksDir({
    brief: '# Brief\n\n**No backend changes**.\n',
    tasks: '<!-- wiring -->',
    prContext: { base: 'origin/main', files: ['components/Foo.tsx'] },
  });
  const r = wiring.validate({ tasksDir });
  assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('backend BLOCKS when Requirement Coverage has non-delivered rows', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: [
      '<!-- backend -->',
      '',
      '## Requirement Coverage',
      '',
      '| ID | Requirement | Status | Evidence |',
      '| --- | --- | --- | --- |',
      '| R1 | Add endpoint | DELIVERED | foo.ts:42 |',
      '| R2 | Add validation | PENDING |  |',
      '',
    ].join('\n'),
    prContext: { base: 'origin/main', files: ['app/api/foo.ts'] },
  });
  const r = backend.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /incomplete|PENDING|R2/i.test(e)));
  fs.rmSync(root, { recursive: true, force: true });
});
