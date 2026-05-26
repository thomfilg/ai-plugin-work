'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const draft = require('../lib/phases/draft');

function mkDir(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-shared-'));
  const tasksDir = path.join(root, 'ECHO-9999');
  fs.mkdirSync(tasksDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(tasksDir, name), content);
  }
  return { root, tasksDir };
}

const SPEC_GENERIC_SPLIT = [
  '# Spec',
  '',
  '## Component Shape Decision',
  '',
  '| Proposed | Data | Other pages? | Decision | Rationale |',
  '|---|---|---|---|---|',
  '| `UsersTable` | `users[]` | Yes | **Split: Generic `Table` + Specific `UsersTable`** | shared shell |',
  '',
].join('\n');

const SPEC_SPECIFIC_ONLY = [
  '# Spec',
  '',
  '## Component Shape Decision',
  '',
  '| Proposed | Data | Other pages? | Decision | Rationale |',
  '|---|---|---|---|---|',
  '| `WorkbookSidebar` | `wb` | No | **Specific-only** | page-local hook `useWorkbookCtx` |',
  '',
].join('\n');

function buildTasksMd({ task1Title, task1Files }) {
  return [
    '## Extracted Requirements',
    '- R1',
    '',
    `## Task 1 — ${task1Title}`,
    '',
    '### Type',
    'frontend',
    '',
    '### Dependencies',
    'none',
    '',
    '### Requirements Covered',
    '- R1',
    '',
    '### Acceptance Criteria',
    '- it builds',
    '',
    '### Files in scope',
    ...task1Files.map((f) => `- \`${f}\``),
    '',
  ].join('\n');
}

test('PASSES when Task 1 scaffolds Generic shell in shared/', () => {
  const { root, tasksDir } = mkDir({
    'spec.md': SPEC_GENERIC_SPLIT,
    'tasks.md': buildTasksMd({
      task1Title: 'Scaffold generic `Table` component',
      task1Files: ['src/shared/ui/Table.tsx', 'src/shared/ui/Table.test.tsx'],
    }),
  });
  const errors = draft.validateArtifacts(tasksDir);
  assert.equal(errors.length, 0, `expected no errors, got: ${JSON.stringify(errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('BLOCKS when Generic-split declared but Task 1 has no shared/ path', () => {
  const { root, tasksDir } = mkDir({
    'spec.md': SPEC_GENERIC_SPLIT,
    'tasks.md': buildTasksMd({
      task1Title: 'Build UsersTable component',
      task1Files: ['src/pages/users/UsersTable.tsx'],
    }),
  });
  const errors = draft.validateArtifacts(tasksDir);
  assert.ok(
    errors.some((e) => /Task 1 must scaffold the shared component/i.test(e)),
    `expected shared-scaffold error, got: ${JSON.stringify(errors)}`
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('BLOCKS when Task 1 touches shared/ but does not mention the generic name', () => {
  const { root, tasksDir } = mkDir({
    'spec.md': SPEC_GENERIC_SPLIT,
    'tasks.md': buildTasksMd({
      task1Title: 'Wire something up',
      task1Files: ['src/shared/util/unrelated.ts'],
    }),
  });
  const errors = draft.validateArtifacts(tasksDir);
  assert.ok(
    errors.some((e) => /mention the shared component name/i.test(e)),
    `expected name-mention error, got: ${JSON.stringify(errors)}`
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('does NOT enforce shared-scaffold rule when spec has no Generic-split rows', () => {
  const { root, tasksDir } = mkDir({
    'spec.md': SPEC_SPECIFIC_ONLY,
    'tasks.md': buildTasksMd({
      task1Title: 'Build WorkbookSidebar',
      task1Files: ['src/pages/workbook/WorkbookSidebar.tsx'],
    }),
  });
  const errors = draft.validateArtifacts(tasksDir);
  assert.equal(errors.length, 0, `expected no errors, got: ${JSON.stringify(errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('does NOT enforce shared-scaffold rule when spec.md is missing', () => {
  const { root, tasksDir } = mkDir({
    'tasks.md': buildTasksMd({
      task1Title: 'Some task',
      task1Files: ['src/foo.ts'],
    }),
  });
  const errors = draft.validateArtifacts(tasksDir);
  assert.equal(errors.length, 0, `expected no errors when no spec, got: ${JSON.stringify(errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('accepts shared paths under packages/ui/', () => {
  const { root, tasksDir } = mkDir({
    'spec.md': SPEC_GENERIC_SPLIT,
    'tasks.md': buildTasksMd({
      task1Title: 'Add Table to packages/ui',
      task1Files: ['packages/ui/src/Table.tsx'],
    }),
  });
  const errors = draft.validateArtifacts(tasksDir);
  assert.equal(errors.length, 0, `expected no errors, got: ${JSON.stringify(errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('finds the task numbered 1 even when it appears AFTER Task 2 in document order', () => {
  // Regression: validateSharedComponentOrdering used to use taskBlocks[0]
  // (first-in-file) instead of finding the task whose `## Task N` header is
  // 1. If Task 2 was written before Task 1, the gate evaluated Task 2
  // and produced a misleading "Task 1 must scaffold..." error.
  const tasksMd = [
    '## Extracted Requirements',
    '- R1',
    '',
    '## Task 2 — Page-specific UsersTable wrapper',
    '',
    '### Type',
    'frontend',
    '### Dependencies',
    'Task 1',
    '### Requirements Covered',
    '- R1',
    '### Acceptance Criteria',
    '- it builds',
    '### Files in scope',
    '- `src/pages/users/UsersTable.tsx`',
    '',
    '## Task 1 — Scaffold generic `Table` component',
    '',
    '### Type',
    'frontend',
    '### Dependencies',
    'none',
    '### Requirements Covered',
    '- R1',
    '### Acceptance Criteria',
    '- it builds',
    '### Files in scope',
    '- `src/shared/ui/Table.tsx`',
    '',
  ].join('\n');
  const { root, tasksDir } = mkDir({ 'spec.md': SPEC_GENERIC_SPLIT, 'tasks.md': tasksMd });
  const errors = draft.validateArtifacts(tasksDir);
  // Task 1 (actually numbered 1) scaffolds the shared component → no error.
  // The buggy version would have evaluated Task 2 (first in file) and reported
  // "Task 1 must scaffold..." even though Task 1 is correct.
  assert.equal(errors.length, 0, `expected no errors, got: ${JSON.stringify(errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('error message reports the actual task number found when no Task 1 exists', () => {
  // Edge case: tasks file has no `## Task 1` (authors started numbering from
  // 2 by mistake). The gate should report the actual task it evaluated,
  // not a hardcoded "Task 1".
  const tasksMd = [
    '## Extracted Requirements',
    '- R1',
    '',
    '## Task 2 — Build UsersTable',
    '',
    '### Type',
    'frontend',
    '### Dependencies',
    'none',
    '### Requirements Covered',
    '- R1',
    '### Acceptance Criteria',
    '- it builds',
    '### Files in scope',
    '- `src/pages/users/UsersTable.tsx`',
    '',
  ].join('\n');
  const { root, tasksDir } = mkDir({ 'spec.md': SPEC_GENERIC_SPLIT, 'tasks.md': tasksMd });
  const errors = draft.validateArtifacts(tasksDir);
  assert.ok(
    errors.some((e) => /Task 2 must scaffold/i.test(e)),
    `expected error referring to "Task 2", got: ${JSON.stringify(errors)}`
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('extractFilesInScope parses bullet list correctly', () => {
  const body = [
    '### Type',
    'frontend',
    '',
    '### Files in scope',
    '- `a/b.ts`',
    '- `c/d.tsx`',
    '  not a bullet (indented prose)',
    '',
    '### Acceptance Criteria',
    '- something',
  ].join('\n');
  const files = draft.extractFilesInScope(body);
  assert.deepEqual(files, ['a/b.ts', 'c/d.tsx']);
});
