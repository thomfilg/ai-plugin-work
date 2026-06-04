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
const specShared = require('../lib/kind-checks/shared');

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

test('wiring appliesTo fires on ECHO-4579 even when tasks declare only frontend (no Type:wiring)', () => {
  // Anti-regression for the gating bug the per-task ### Type change introduced:
  // wiring used to require `### Type: wiring` OR `kinds.length === 0`. Real
  // ECHO-4579 tickets have `### Type: frontend` tasks, so the wiring check
  // would silently skip — the exact case it's meant to defend.
  const wiring = require('../lib/kind-checks/wiring');
  const { root, tasksDir } = makeTasksDir({
    brief: '# Brief\n\nHard constraint: **No backend changes** — sibling-owned.\n',
    spec: [
      '# Spec',
      '',
      '## Files to Create/Modify',
      '',
      '- `app/api/trpc/routers/explore.ts` — add field projection',
      '',
    ].join('\n'),
    tasks: '# Tasks\n\n## Task 1\n\n### Type: frontend\n',
  });
  assert.equal(wiring.appliesTo({ tasksDir }), true, 'wiring must fire when brief forbids backend and spec lists a backend file, regardless of task kinds');
  fs.rmSync(root, { recursive: true, force: true });
});

test('wiring appliesTo does NOT fire when brief forbids backend but spec has no backend files', () => {
  const wiring = require('../lib/kind-checks/wiring');
  const { root, tasksDir } = makeTasksDir({
    brief: '# Brief\n\nHard constraint: **No backend changes**.\n',
    spec: '# Spec\n\n## Files to Create/Modify\n\n- `components/Foo.tsx`\n',
    tasks: '# Tasks\n\n## Task 1\n\n### Type: frontend\n',
  });
  assert.equal(wiring.appliesTo({ tasksDir }), false, 'wiring should not fire when there is no backend file to defend against');
  fs.rmSync(root, { recursive: true, force: true });
});

test('fullstack appliesTo fires when tasks declare BOTH frontend AND backend (per-task composition)', () => {
  const fullstack = require('../lib/kind-checks/fullstack');
  const { root, tasksDir } = makeTasksDir({
    spec: '# Spec\n',
    tasks: '# Tasks\n\n## Task 1\n\n### Type: frontend\n\n## Task 2\n\n### Type: backend\n',
  });
  assert.equal(fullstack.appliesTo({ tasksDir }), true, 'fullstack must fire when tasks compose to frontend + backend, not require `### Type: fullstack`');
  fs.rmSync(root, { recursive: true, force: true });
});

test('fullstack appliesTo fires when spec references frontend backtick identifiers (cross-cut precondition)', () => {
  const fullstack = require('../lib/kind-checks/fullstack');
  const { root, tasksDir } = makeTasksDir({
    spec: '# Spec\n\nThe component reads field `workbookId` from the backend.\n',
    tasks: '# Tasks\n\n## Task 1\n\n### Type: frontend\n',
  });
  assert.equal(fullstack.appliesTo({ tasksDir }), true, 'fullstack must fire when spec has frontend->backend identifier references (the cross-cut precondition)');
  fs.rmSync(root, { recursive: true, force: true });
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

// ─── detectKinds() structural parsing of ### Type headers (GH-486) ────────

test('detectKinds parses block form: ### Type then value on next line', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: '# Tasks\n\n## Task 1\n\n### Type\nfrontend\n',
  });
  assert.deepEqual(specShared.detectKinds(tasksDir).sort(), ['frontend']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('detectKinds parses inline form: ### Type: <kind>', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: '# Tasks\n\n## Task 1\n\n### Type: e2e\n',
  });
  assert.deepEqual(specShared.detectKinds(tasksDir).sort(), ['e2e']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('detectKinds unions multiple tasks with mixed kinds', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: [
      '# Tasks',
      '## Task 1',
      '### Type: frontend',
      '## Task 2',
      '### Type: backend',
      '## Task 3',
      '### Type',
      'devops',
    ].join('\n'),
  });
  assert.deepEqual(
    specShared.detectKinds(tasksDir).sort(),
    ['backend', 'devops', 'frontend']
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('detectKinds returns [] for non-kind ### Type values (feature/implementation/checkpoint) — these are work-types, NOT malformed', () => {
  // Cursor Bugbot: ### Type is overloaded across the codebase. work-orchestrator,
  // task-parser, check-gate, verify-per-task fixtures use feature/implementation/
  // checkpoint as Type values. detectKinds must NOT throw on these — the header
  // is present, it just isn't kind-axis.
  for (const value of ['feature', 'implementation', 'checkpoint', 'nonsense']) {
    const { root, tasksDir } = makeTasksDir({
      tasks: `# Tasks\n\n## Task 1\n\n### Type: ${value}\n`,
    });
    assert.deepEqual(
      specShared.detectKinds(tasksDir),
      [],
      `expected [] for non-kind Type value "${value}", but it threw or returned a kind`
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detectKinds THROWS when any ## Task block lacks a ### Type header (per-task guard)', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: '# Tasks\n\n## Task 1\n\nSome description, no Type header.\n\n## Task 2\n\nAlso no Type.\n',
  });
  assert.throws(
    () => specShared.detectKinds(tasksDir),
    (err) =>
      err instanceof specShared.MalformedTasksError &&
      /2 of 2 task block\(s\) missing/.test(err.message) &&
      /Task 1, Task 2/.test(err.message),
    'expected MalformedTasksError naming the missing tasks'
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('detectKinds THROWS when ONE task is missing ### Type, even if a sibling has it (bypass surface closed)', () => {
  // Cursor Bugbot follow-up: a global "any Type header counts" guard let
  // tasks slip through if one sibling task had a header. The guard must be
  // per-task — every numbered ## Task block needs its own ### Type.
  const { root, tasksDir } = makeTasksDir({
    tasks: '# Tasks\n\n## Task 1\n\n### Type: feature\n\n## Task 2\n\nNo Type header — bypass attempt.\n',
  });
  assert.throws(
    () => specShared.detectKinds(tasksDir),
    (err) =>
      err instanceof specShared.MalformedTasksError &&
      /1 of 2 task block\(s\) missing/.test(err.message) &&
      /Task 2/.test(err.message) &&
      !/Task 1[^0-9]/.test(err.message),
    'expected error to call out Task 2 only'
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('detectKinds returns ["frontend"] for mixed tasks: one Type:feature + one Type:frontend', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: '# Tasks\n\n## Task 1\n\n### Type: feature\n\n## Task 2\n\n### Type: frontend\n',
  });
  assert.deepEqual(specShared.detectKinds(tasksDir), ['frontend']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('detectKinds returns [] when tasks.md is absent', () => {
  const { root, tasksDir } = makeTasksDir({ spec: '# Spec\n' });
  assert.deepEqual(specShared.detectKinds(tasksDir), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('detectKinds returns [] for prose ## Task <word> headings (no number) — aligns with task-parser', () => {
  // Cursor Bugbot: ## Task overview / ## Task summary / ## Task notes are
  // prose sections, not numbered tasks. task-parser splits on /^## Task (\d+)/m;
  // we must match that — otherwise a non-numbered ## Task heading with no
  // ### Type triggers MalformedTasksError even though parseTasks returns null.
  for (const heading of ['## Task overview', '## Task summary', '## Task notes', '## Tasks']) {
    const { root, tasksDir } = makeTasksDir({
      tasks: `# Tasks\n\n${heading}\n\nProse, no Type header — should not trigger bypass guard.\n`,
    });
    assert.deepEqual(
      specShared.detectKinds(tasksDir),
      [],
      `expected [] for prose heading "${heading}" but it threw or returned a kind`
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detectKinds returns [] when tasks.md exists but has no ## Task blocks', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: '# Tasks\n\nThis ticket has no tasks yet.\n',
  });
  assert.deepEqual(specShared.detectKinds(tasksDir), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('detectKinds ignores ### Type headers that are NOT inside a ## Task block', () => {
  // Floating ### Type at file scope, under a non-Task ## section, or before
  // any ## Task heading. Must not contribute — would contradict the
  // "no ## Task blocks → []" invariant.
  for (const fixture of [
    '# Tasks\n\n### Type: frontend\n',                                  // floating, no task
    '# Tasks\n\n## Notes\n\n### Type: frontend\n',                       // under non-Task ## section
    '# Tasks\n\n### Type: frontend\n\n## Task 1\n\n### Type: feature\n', // before first ## Task; the inside-task header is non-kind
  ]) {
    const { root, tasksDir } = makeTasksDir({ tasks: fixture });
    assert.deepEqual(specShared.detectKinds(tasksDir), [], `fixture leaked a floating Type into kinds: ${JSON.stringify(fixture)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detectKinds: ### Type after a ## Task block ends (next ## heading) does NOT count', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: '# Tasks\n\n## Task 1\n\n### Type: feature\n\n## Appendix\n\n### Type: backend\n',
  });
  // Task 1 has Type: feature → no kind. The backend Type under ## Appendix is outside any task block → ignored.
  assert.deepEqual(specShared.detectKinds(tasksDir), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('detectKinds skips empty ### Type whose next non-empty line is another heading', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: [
      '# Tasks',
      '## Task 1',
      '### Type',
      '',
      '## Task 2',
      '### Type: frontend',
    ].join('\n'),
  });
  assert.deepEqual(specShared.detectKinds(tasksDir).sort(), ['frontend']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('detectKinds is case-insensitive on header and value', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: '# Tasks\n\n## Task 1\n\n### type: FRONTEND\n',
  });
  assert.deepEqual(specShared.detectKinds(tasksDir).sort(), ['frontend']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('detectKinds ignores prose in spec.md AND deferral annotations in tasks.md (ECHO-5538 anti-regression)', () => {
  const { root, tasksDir } = makeTasksDir({
    spec: [
      '# Spec',
      '## Scope notes',
      '- @e2e coverage is out of scope',
      '- backend changes intentionally deferred',
      '- wiring not covered by this ticket',
    ].join('\n'),
    tasks: [
      '# Tasks',
      '## Task 1',
      '### Type: frontend',
      '## Task 2',
      '### Type: frontend',
      '## Gherkin Coverage',
      '| G7 @e2e admin escalation | **Not covered** — intentionally deferred |',
      '## Notes',
      '- backend retry cases not covered by v1',
    ].join('\n'),
  });
  assert.deepEqual(specShared.detectKinds(tasksDir).sort(), ['frontend']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('preflightTasksManifest returns { ok: false, error } when any ## Task block lacks ### Type', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: '# Tasks\n\n## Task 1\n\nNo Type header.\n',
  });
  const r = specShared.preflightTasksManifest(tasksDir);
  assert.equal(r.ok, false);
  assert.match(r.error, /1 of 1 task block\(s\) missing/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('preflightTasksManifest returns { ok: true } for tasks.md with non-kind Type values (feature/implementation)', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: '# Tasks\n\n## Task 1\n\n### Type: feature\n\n## Task 2\n\n### Type: implementation\n',
  });
  assert.deepEqual(specShared.preflightTasksManifest(tasksDir), { ok: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('preflightTasksManifest returns { ok: true } for well-formed tasks.md', () => {
  const { root, tasksDir } = makeTasksDir({
    tasks: '# Tasks\n\n## Task 1\n\n### Type: frontend\n',
  });
  assert.deepEqual(specShared.preflightTasksManifest(tasksDir), { ok: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('orchestrator-level bypass guard: kind_checks phase FAILS LOUDLY on malformed tasks.md', () => {
  // Proves Cursor Bugbot's finding is fixed: per-handler try/catch in
  // validate() can no longer swallow MalformedTasksError, because the
  // pre-flight runs BEFORE the handler loop and short-circuits the phase.
  const kindChecksPhase = require('../lib/phases/kind_checks');
  let captured = null;
  const fakeRegister = (_phaseName, handler) => { captured = handler; };
  kindChecksPhase(fakeRegister);
  assert.ok(captured && typeof captured.validate === 'function', 'expected phase handler to register validate()');

  const { root, tasksDir } = makeTasksDir({
    tasks: '# Tasks\n\n## Task 1\n\nNo Type header — bypass attempt.\n',
  });
  const result = captured.validate({ ticket: 'ECHO-7777', tasksDir });
  assert.equal(result.ok, false, 'expected phase to fail loudly');
  assert.ok(/missing a "### Type"/.test(result.errors[0]), `expected MalformedTasksError message in errors, got: ${JSON.stringify(result.errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('parity: every sibling shared.js re-exports the SAME detectKinds function (runtime identity)', () => {
  const repoRoot = path.resolve(__dirname, '../../../../../..');
  const SIBLING_PATHS = [
    'plugins/work/scripts/workflows/work-code-checker/lib/kind-checks/shared.js',
    'plugins/work/scripts/workflows/work-completion-checker/lib/kind-checks/shared.js',
    'plugins/work/scripts/workflows/work-pr-reviewer/lib/kind-checks/shared.js',
    'plugins/work/scripts/workflows/work-qa-feature-tester/lib/kind-checks/shared.js',
    'plugins/work/scripts/workflows/work-task-review/lib/kind-checks/shared.js',
  ];
  for (const rel of SIBLING_PATHS) {
    const abs = path.join(repoRoot, rel);
    assert.ok(fs.existsSync(abs), `sibling shared.js missing: ${rel}`);
    const mod = require(abs);
    assert.strictEqual(
      mod.detectKinds,
      specShared.detectKinds,
      `sibling does not re-export the same detectKinds reference: ${rel}`
    );
    assert.strictEqual(
      mod.MalformedTasksError,
      specShared.MalformedTasksError,
      `sibling does not re-export MalformedTasksError: ${rel}`
    );
    assert.strictEqual(
      mod.preflightTasksManifest,
      specShared.preflightTasksManifest,
      `sibling does not re-export preflightTasksManifest: ${rel}`
    );
  }
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
