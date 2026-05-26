'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const diffScope = require('../lib/phases/diff_scope');

function makeTasksDir({ tasks = '', prContext = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-scope-'));
  const tasksDir = path.join(root, 'ECHO-7777');
  fs.mkdirSync(tasksDir, { recursive: true });
  if (tasks) fs.writeFileSync(path.join(tasksDir, 'tasks.md'), tasks);
  if (prContext)
    fs.writeFileSync(path.join(tasksDir, 'pr-context.json'), JSON.stringify(prContext));
  return { root, tasksDir };
}

test('BLOCKS when diff contains sibling-owned (out of scope) files', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: [
      '### Task 1',
      '### Files in scope',
      '- `components/A.tsx`',
      '',
      '### Files explicitly out of scope',
      '- `lib/sibling/schema.ts`',
      '',
    ].join('\n'),
    prContext: {
      base: 'origin/main',
      files: ['components/A.tsx', 'lib/sibling/schema.ts'],
    },
  });
  const r = diffScope.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('sibling-owned') || r.errors[0].includes('Gate E'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('warns on unaccounted files but does not block', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: ['### Task 1', '### Files in scope', '- `components/A.tsx`', ''].join('\n'),
    prContext: {
      base: 'origin/main',
      files: ['components/A.tsx', 'components/random.tsx'],
    },
  });
  const r = diffScope.validate({ tasksDir });
  assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
  assert.ok(r.warnings.some((w) => w.includes('unaccounted')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('passes when all files are in scope', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: [
      '### Task 1',
      '### Files in scope',
      '- `components/A.tsx`',
      '- `lib/helper.ts`',
      '',
    ].join('\n'),
    prContext: {
      base: 'origin/main',
      files: ['components/A.tsx', 'lib/helper.ts'],
    },
  });
  const r = diffScope.validate({ tasksDir });
  assert.equal(r.ok, true);
  assert.equal((r.warnings || []).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
