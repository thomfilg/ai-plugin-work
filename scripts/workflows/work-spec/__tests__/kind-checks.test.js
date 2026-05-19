'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getKindCheckRegistry } = require('../lib/kind-checks/kind-registry');
const wiring = require('../lib/kind-checks/wiring');
const fullstack = require('../lib/kind-checks/fullstack');

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
