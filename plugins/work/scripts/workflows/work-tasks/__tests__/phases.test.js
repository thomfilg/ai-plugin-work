'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const reqExtract = require('../lib/phases/requirements_extract');
const draft = require('../lib/phases/draft');
const traceability = require('../lib/phases/traceability');
const kindAssign = require('../lib/phases/kind_assign');
const gherkinLink = require('../lib/phases/gherkin_link');

function mkTasksDir(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-phases-'));
  const tasksDir = path.join(root, 'ECHO-9999');
  fs.mkdirSync(tasksDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(tasksDir, name), content);
  }
  return { root, tasksDir };
}

test('requirements_extract blocks when section is missing', () => {
  const { root, tasksDir } = mkTasksDir({
    'tasks.md': '# tasks\n\n(no requirements section)\n',
  });
  const r = reqExtract.validate({ tasksDir });
  assert.equal(r.ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('requirements_extract passes when section has IDs', () => {
  const { root, tasksDir } = mkTasksDir({
    'tasks.md': [
      '## Extracted Requirements',
      '',
      '- R1 — render the dashboard',
      '- R2 — sort by name',
      '',
      '## Task 1 — render',
      '',
    ].join('\n'),
  });
  const r = reqExtract.validate({ tasksDir });
  assert.equal(r.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('draft blocks when a task is missing a required subsection', () => {
  const { root, tasksDir } = mkTasksDir({
    'tasks.md': [
      '## Extracted Requirements',
      '- R1',
      '',
      '## Task 1 — partial',
      '',
      '### Type',
      'frontend',
      '',
      '### Dependencies',
      'none',
      '',
      '### Requirements Covered',
      '- R1',
      // missing Acceptance Criteria + Files in scope
      '',
    ].join('\n'),
  });
  const r = draft.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /Acceptance Criteria/.test(e)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('traceability flags orphan requirement and unknown task ref', () => {
  const { root, tasksDir } = mkTasksDir({
    'tasks.md': [
      '## Extracted Requirements',
      '- R1',
      '- R2',
      '',
      '## Task 1',
      '',
      '### Type',
      'frontend',
      '',
      '### Requirements Covered',
      '- R1',
      '- R99', // unknown
      '',
      '### Acceptance Criteria',
      '- ok',
      '',
      '### Files in scope',
      '- `components/foo.tsx`',
      '',
    ].join('\n'),
  });
  const r = traceability.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /R2/.test(e)),
    'orphan requirement R2 should be reported'
  );
  assert.ok(
    r.errors.some((e) => /R99/.test(e)),
    'unknown R99 should be reported'
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('kind_assign blocks wiring task that touches backend (ECHO-4579 defense)', () => {
  const { root, tasksDir } = mkTasksDir({
    'tasks.md': [
      '## Task 1',
      '',
      '### Type',
      'wiring',
      '',
      '### Dependencies',
      'none',
      '',
      '### Requirements Covered',
      '- R1',
      '',
      '### Acceptance Criteria',
      '- ok',
      '',
      '### Files in scope',
      '- `app/api/trpc/routers/explore.ts`',
      '',
    ].join('\n'),
  });
  const r = kindAssign.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /ECHO-4579/.test(e)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('kind_assign blocks backend task missing integration test in scope', () => {
  const { root, tasksDir } = mkTasksDir({
    'tasks.md': [
      '## Task 1',
      '',
      '### Type',
      'backend',
      '',
      '### Files in scope',
      '- `app/api/trpc/routers/foo.ts`',
      '',
    ].join('\n'),
  });
  const r = kindAssign.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /integration\.test/.test(e)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('gherkin_link auto-passes when gherkin.feature is absent', () => {
  const { root, tasksDir } = mkTasksDir({ 'tasks.md': '## Task 1\n' });
  const r = gherkinLink.validate({ tasksDir });
  assert.equal(r.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('gherkin_link blocks when a Scenario has no task reference (fallback path)', () => {
  const { root, tasksDir } = mkTasksDir({
    'gherkin.feature': [
      'Feature: stuff',
      '  Scenario: render the unique-scenario-title-12345',
      '    Given a thing',
      '    When something',
      '    Then expect outcome',
      '',
    ].join('\n'),
    'tasks.md': '## Task 1\n\nSome content without the title.\n',
  });
  const r = gherkinLink.validate({ tasksDir });
  // Either the canonical validator returns errors, OR our fallback does —
  // either way, the missing scenario reference should surface.
  assert.equal(r.ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});
