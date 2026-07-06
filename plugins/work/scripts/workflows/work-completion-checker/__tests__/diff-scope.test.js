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

// --- GH-408 false-positive family (ECHO-5357/5813/5815/5538/5150) ---

test('h3 sibling sections after out-of-scope are not swallowed (ECHO-5357/5813)', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: [
      '## Task 1 — schema',
      '### Files in scope',
      '- `prisma/schema.prisma`',
      '- `lib/permissions/permission-rule-schema.integration.test.ts`',
      '',
      '### Files explicitly out of scope',
      '- `components/**`',
      '',
      '### Deliverables',
      '- `prisma/schema.prisma` gains `isLocked` column',
      '',
      '### Test Command',
      '- `pnpm vitest run lib/permissions/permission-rule-schema.integration.test.ts`',
      '',
      '### Suggested Scope',
      '- `prisma/schema.prisma`',
      '',
    ].join('\n'),
    prContext: {
      base: 'origin/main',
      files: ['prisma/schema.prisma', 'lib/permissions/permission-rule-schema.integration.test.ts'],
    },
  });
  const r = diffScope.validate({ tasksDir });
  assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('code identifiers in out-of-scope blocks are not treated as files (ECHO-5815)', () => {
  const tasks = [
    '## Task 1',
    '### Files explicitly out of scope',
    '- `refreshExtractsMany` refactor',
    '- `useDeletedContentActions`',
    '- do not touch `handler logic` here',
    '- `lib/sibling/schema.ts`',
    '',
  ].join('\n');
  const out = diffScope.parseFilesOutOfScope(tasks);
  assert.deepEqual([...out], ['lib/sibling/schema.ts']);
});

test("every task's out-of-scope block is parsed, not only the first (#408 latent bug)", () => {
  const tasks = [
    '## Task 1',
    '### Files explicitly out of scope',
    '- `lib/sibling/a.ts`',
    '',
    '## Task 2',
    '### Files explicitly out of scope',
    '- `lib/sibling/b.ts`',
    '',
  ].join('\n');
  const out = diffScope.parseFilesOutOfScope(tasks);
  assert.ok(out.has('lib/sibling/a.ts'));
  assert.ok(out.has('lib/sibling/b.ts'));
});

test('in-scope anywhere beats out-of-scope elsewhere (ECHO-5538/5360)', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: [
      '## Task 1',
      '### Files in scope',
      '- `lib/task1.ts`',
      '### Files explicitly out of scope',
      '- `components/home/recycle-bin-content/recycle-bin-content.tsx`',
      '',
      '## Task 3',
      '### Files in scope',
      '- `components/home/recycle-bin-content/recycle-bin-content.tsx`',
      '',
    ].join('\n'),
    prContext: {
      base: 'origin/main',
      files: ['lib/task1.ts', 'components/home/recycle-bin-content/recycle-bin-content.tsx'],
    },
  });
  const r = diffScope.validate({ tasksDir });
  assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
  assert.equal((r.warnings || []).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('#408 repro: Task 4 checkpoint reclaims files Task 1 listed out of scope', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: [
      '## Task 1 — foundation',
      '### Files in scope',
      '- `lib/foundation.ts`',
      '### Files explicitly out of scope',
      '- `lib/feature-a.ts`',
      '- `lib/feature-b.ts`',
      '',
      '## Task 2 — feature A',
      '### Files in scope',
      '- `lib/feature-a.ts`',
      '',
      '## Task 3 — feature B',
      '### Files in scope',
      '- `lib/feature-b.ts`',
      '',
      '## Task 4 — checkpoint',
      '### Files in scope',
      '- `lib/feature-a.ts`',
      '- `lib/feature-b.ts`',
      '',
    ].join('\n'),
    prContext: {
      base: 'origin/main',
      files: ['lib/feature-a.ts', 'lib/feature-b.ts'],
    },
  });
  const r = diffScope.validate({ tasksDir });
  assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
  assert.equal((r.warnings || []).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('still BLOCKS files claimed by no task even with multiple out-of-scope blocks', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: [
      '## Task 1',
      '### Files in scope',
      '- `lib/mine.ts`',
      '### Files explicitly out of scope',
      '- `lib/sibling/a.ts`',
      '',
      '## Task 2',
      '### Files explicitly out of scope',
      '- `lib/sibling/b.ts`',
      '',
    ].join('\n'),
    prContext: {
      base: 'origin/main',
      files: ['lib/mine.ts', 'lib/sibling/b.ts'],
    },
  });
  const r = diffScope.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('lib/sibling/b.ts'));
  fs.rmSync(root, { recursive: true, force: true });
});

// --- scope-accepted.json override (ECHO-5150/5813 unblock path) ---

test('scope-accepted.json excuses exact listed paths with a warning', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: [
      '## Task 1',
      '### Files in scope',
      '- `lib/mine.ts`',
      '### Files explicitly out of scope',
      '- `lib/sibling/schema.ts`',
      '',
    ].join('\n'),
    prContext: {
      base: 'origin/main',
      files: ['lib/mine.ts', 'lib/sibling/schema.ts'],
    },
  });
  fs.writeFileSync(
    path.join(tasksDir, diffScope.OVERRIDE_FILE),
    JSON.stringify({
      reason: 'sibling procedures verified untouched via git diff grep',
      files: ['lib/sibling/schema.ts'],
    })
  );
  const r = diffScope.validate({ tasksDir });
  assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
  assert.ok(r.warnings.some((w) => w.includes('scope-accepted.json')));
  assert.ok(r.warnings.some((w) => w.includes('verified untouched')));
  const snapshot = JSON.parse(fs.readFileSync(path.join(tasksDir, diffScope.CTX_FILE), 'utf8'));
  assert.deepEqual(snapshot.accepted, ['lib/sibling/schema.ts']);
  assert.deepEqual(snapshot.outOfScope, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scope-accepted.json without reason or files is ignored (no blanket bypass)', () => {
  for (const bad of [
    { files: ['lib/sibling/schema.ts'] }, // no reason
    { reason: 'because', files: [] }, // empty files
    { reason: '   ', files: ['lib/sibling/schema.ts'] }, // blank reason
    { reason: 'because' }, // files missing entirely
  ]) {
    const { root, tasksDir } = makeTasksDir({
      tasks: [
        '## Task 1',
        '### Files explicitly out of scope',
        '- `lib/sibling/schema.ts`',
        '',
      ].join('\n'),
      prContext: { base: 'origin/main', files: ['lib/sibling/schema.ts'] },
    });
    fs.writeFileSync(path.join(tasksDir, diffScope.OVERRIDE_FILE), JSON.stringify(bad));
    const r = diffScope.validate({ tasksDir });
    assert.equal(r.ok, false, `expected block for ${JSON.stringify(bad)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scope-accepted.json does not excuse unlisted paths', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: [
      '## Task 1',
      '### Files explicitly out of scope',
      '- `lib/sibling/a.ts`',
      '- `lib/sibling/b.ts`',
      '',
    ].join('\n'),
    prContext: { base: 'origin/main', files: ['lib/sibling/a.ts', 'lib/sibling/b.ts'] },
  });
  fs.writeFileSync(
    path.join(tasksDir, diffScope.OVERRIDE_FILE),
    JSON.stringify({ reason: 'a.ts verified manually', files: ['lib/sibling/a.ts'] })
  );
  const r = diffScope.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('lib/sibling/b.ts'));
  assert.ok(!r.errors[0].includes('`lib/sibling/a.ts`'));
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
