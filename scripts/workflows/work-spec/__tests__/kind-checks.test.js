'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getKindCheckRegistry } = require('../lib/kind-checks/kind-registry');
const wiring = require('../lib/kind-checks/wiring');
const fullstack = require('../lib/kind-checks/fullstack');
const e2e = require('../lib/kind-checks/e2e');

function makeTasksDir({ brief = '', spec = '', tasks = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kind-check-'));
  const tasksDir = path.join(root, 'ECHO-7777');
  fs.mkdirSync(tasksDir, { recursive: true });
  if (brief) fs.writeFileSync(path.join(tasksDir, 'brief.md'), brief);
  if (spec) fs.writeFileSync(path.join(tasksDir, 'spec.md'), spec);
  if (tasks) fs.writeFileSync(path.join(tasksDir, 'tasks.md'), tasks);
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

test('wiring BLOCKS the ECHO-4579 scenario (no backend changes + backend file in spec)', () => {
  const { root, tasksDir } = makeTasksDir({
    brief: '# Brief\n\nHard constraint: **No backend changes** — sibling-owned.\n',
    spec: [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- nothing',
      '',
      '## Files to Create/Modify',
      '',
      '- `app/api/trpc/routers/explore.ts` — add field projection',
      '- `lib/explore/explore.schemas.ts` — add workbookId',
      '',
      '<!-- wiring kind -->',
      '',
    ].join('\n'),
  });
  // Force kind detection to include "wiring".
  const r = wiring.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  assert.ok(r.errors[0].includes('app/api') || r.errors[0].includes('ECHO-4579'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('wiring passes when no backend file is listed', () => {
  const { root, tasksDir } = makeTasksDir({
    brief: '# Brief\n\n**No backend changes** — sibling-owned.\n',
    spec: [
      '# Spec',
      '',
      '## Files to Create/Modify',
      '',
      '- `components/foo/Bar.tsx` — new component',
      '',
      '<!-- wiring -->',
      '',
    ].join('\n'),
  });
  const r = wiring.validate({ tasksDir });
  assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('fullstack cross-cut fails when frontend references a field not in Verified surface', () => {
  const { root, tasksDir } = makeTasksDir({
    brief: '# Brief',
    spec: [
      '# Spec',
      '',
      '## Architecture Decisions',
      '',
      '- Frontend will render field `workbookId` from server payload.',
      '',
      '## Verified sibling surface',
      '',
      '- `lib/explore/explore.schemas.ts::id` — found',
      '- `lib/explore/explore.schemas.ts::title` — found',
      '',
      '<!-- fullstack -->',
      '',
    ].join('\n'),
  });
  const r = fullstack.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('workbookId')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('fullstack passes when every referenced frontend field is verified', () => {
  const { root, tasksDir } = makeTasksDir({
    brief: '# Brief',
    spec: [
      '# Spec',
      '',
      '## Security Considerations',
      '',
      '- Input validation via zod schemas at procedure boundary.',
      '',
      '## Architecture Decisions',
      '',
      '- Frontend renders field `workbookId` from explore.list output.',
      '',
      '## Verified sibling surface',
      '',
      '- `lib/explore/explore.schemas.ts::workbookId` — found',
      '',
      '## Files to Create/Modify',
      '',
      '- `components/foo.tsx`',
      '- `app/api/trpc/routers/explore.ts` — add field (procedure)',
      '',
      '<!-- fullstack -->',
      '',
    ].join('\n'),
  });
  const r = fullstack.validate({ tasksDir });
  // We tolerate warnings — only blocking errors fail this test.
  assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

// ─── Selector audit (ECHO-4457 regression) ───────────────────────────────

function makeE2eFixture({ specSelectorBlock = '', files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-audit-'));
  const worktreeRoot = path.join(root, 'worktree');
  const tasksDir = path.join(worktreeRoot, 'tasks', 'ECHO-7777');
  fs.mkdirSync(tasksDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(worktreeRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  fs.writeFileSync(
    path.join(tasksDir, 'spec.md'),
    [
      '# Spec',
      '',
      '## Files to Create/Modify',
      '',
      '- `tests/e2e/specs/admin/foo.spec.ts` — new spec',
      '',
      '## Selectors',
      '',
      specSelectorBlock,
      '',
      '<!-- e2e kind, journey + page-object reuse -->',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(tasksDir, 'gherkin.feature'),
    '@e2e\nFeature: foo\n  Scenario: bar\n    Given a\n'
  );
  return { root, tasksDir, worktreeRoot };
}

test('e2e selector audit BLOCKS the ECHO-4457 scenario (existing selector not in sibling file)', () => {
  const { root, tasksDir, worktreeRoot } = makeE2eFixture({
    specSelectorBlock: [
      '- `table-downstream-owners-row-1` — existing — `components/admin/external-asset-tables.tsx`',
    ].join('\n'),
    files: {
      // Sibling component WITHOUT the asserted testid (only has the wrong name)
      'components/admin/external-asset-tables.tsx':
        'export function T(){ return <div data-testid="downstream-owners-row-1"/>; }\n',
    },
  });
  const r = e2e.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.includes('table-downstream-owners-row-1') && e.includes('grep miss')),
    `expected grep-miss error, got: ${JSON.stringify(r.errors)}`
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('e2e selector audit PASSES when selector is present in sibling file', () => {
  const { root, tasksDir, worktreeRoot } = makeE2eFixture({
    specSelectorBlock: [
      '- `send-email-subject-input` — existing — `components/send-email-dialog.tsx`',
    ].join('\n'),
    files: {
      'components/send-email-dialog.tsx':
        'export function D(){ return <input data-testid="send-email-subject-input"/>; }\n',
    },
  });
  const r = e2e.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('e2e selector audit BLOCKS new selector when owning file not in Files to Create/Modify', () => {
  const { root, tasksDir, worktreeRoot } = makeE2eFixture({
    specSelectorBlock: ['- `new-selector` — new — `components/not-in-scope.tsx`'].join('\n'),
  });
  const r = e2e.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.includes('new-selector') && e.includes('NOT in')),
    `expected new-not-in-scope error, got: ${JSON.stringify(r.errors)}`
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('e2e selector audit BLOCKS when ## Selectors section is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-audit-'));
  const worktreeRoot = path.join(root, 'worktree');
  const tasksDir = path.join(worktreeRoot, 'tasks', 'ECHO-7777');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(
    path.join(tasksDir, 'spec.md'),
    [
      '# Spec',
      '## Files to Create/Modify',
      '- `tests/e2e/specs/admin/foo.spec.ts`',
      'journey + page-object',
    ].join('\n')
  );
  fs.writeFileSync(path.join(tasksDir, 'gherkin.feature'), '@e2e\nFeature: foo');
  const r = e2e.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.includes('## Selectors')),
    `expected missing-selectors-section error, got: ${JSON.stringify(r.errors)}`
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('e2e selector audit parser handles both em-dash and hyphen separators', () => {
  const lines = [
    '- `sel-1` — existing — `file-1.tsx`',
    '- `sel-2` - new - `file-2.tsx`',
    '- `sel-3` — bogus — `file-3.tsx`',
    'not a bullet',
  ].join('\n');
  const parsed = e2e.parseSelectorLines(lines);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], { selector: 'sel-1', kind: 'existing', file: 'file-1.tsx' });
  assert.deepEqual(parsed[1], { selector: 'sel-2', kind: 'new', file: 'file-2.tsx' });
  assert.equal(parsed[2].malformed, true);
});
