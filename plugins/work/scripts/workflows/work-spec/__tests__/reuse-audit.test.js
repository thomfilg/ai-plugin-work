'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const reuseAudit = require('../lib/phases/reuse_audit');

function fixture(specContent) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-audit-'));
  const tasksDir = path.join(root, 'tasks', 'ECHO-9999');
  fs.mkdirSync(tasksDir, { recursive: true });
  if (specContent != null) fs.writeFileSync(path.join(tasksDir, 'spec.md'), specContent);
  return { root, tasksDir };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const GOOD_REUSE_AUDIT = [
  '## Reuse Audit',
  '',
  '- `components/foo/Bar.tsx` — covers the empty-state pattern.',
  '',
  '### Codebase search:',
  "- `codegraph_search('Lineage')` → 3 hits across asset, table-detail, workbook.",
  '',
  '### Linear search:',
  '- `mcp__linear__list_issues` keyword "Lineage" → ECHO-4466 ships a sibling component in a different epic.',
  '',
].join('\n');

const GOOD_COMPONENT_SHAPE = [
  '## Component Shape Decision',
  '',
  '| Proposed component | Data inputs | Could be agnostic? | Decision | Rationale |',
  '|---|---|---|---|---|',
  '| `ExternalAssetLineage` | `{nodes, activeId}` | Yes | **Generic `LineagePanel`** | Three call sites need identical layout. |',
  '',
].join('\n');

test('passes when both sections present with full evidence', () => {
  const { root, tasksDir } = fixture(`# Spec\n\n${GOOD_REUSE_AUDIT}\n${GOOD_COMPONENT_SHAPE}\n`);
  const errors = reuseAudit.validateArtifacts(tasksDir);
  assert.equal(errors.length, 0, `expected no errors, got: ${JSON.stringify(errors)}`);
  cleanup(root);
});

test('blocks when Reuse Audit lacks codebase-search evidence', () => {
  const reuse = [
    '## Reuse Audit',
    '',
    '- something here that is at least thirty characters long.',
    '',
    '### Linear search:',
    '- searched ECHO project — no matches.',
    '',
  ].join('\n');
  const { root, tasksDir } = fixture(`${reuse}\n${GOOD_COMPONENT_SHAPE}\n`);
  const errors = reuseAudit.validateArtifacts(tasksDir);
  assert.ok(
    errors.some((e) => /codebase-search/i.test(e)),
    `expected codebase-search error, got: ${JSON.stringify(errors)}`
  );
  cleanup(root);
});

test('blocks when Reuse Audit lacks ticket-provider search evidence', () => {
  const reuse = [
    '## Reuse Audit',
    '',
    '### Codebase search:',
    "- `codegraph_search('Lineage')` → 3 hits.",
    '',
  ].join('\n');
  const { root, tasksDir } = fixture(`${reuse}\n${GOOD_COMPONENT_SHAPE}\n`);
  const errors = reuseAudit.validateArtifacts(tasksDir);
  assert.ok(
    errors.some((e) => /ticket-keyword-search|Linear|Jira/i.test(e)),
    `expected provider-search error, got: ${JSON.stringify(errors)}`
  );
  cleanup(root);
});

test('blocks when Component Shape Decision section is missing', () => {
  const { root, tasksDir } = fixture(`# Spec\n\n${GOOD_REUSE_AUDIT}\n`);
  const errors = reuseAudit.validateArtifacts(tasksDir);
  assert.ok(
    errors.some((e) => /Component Shape Decision/i.test(e)),
    `expected Component Shape Decision error, got: ${JSON.stringify(errors)}`
  );
  cleanup(root);
});

test('blocks when Component Shape Decision table has no data row', () => {
  const emptyShape = [
    '## Component Shape Decision',
    '',
    '| Proposed component | Data inputs | Could be agnostic? | Decision | Rationale |',
    '|---|---|---|---|---|',
    '',
  ].join('\n');
  const { root, tasksDir } = fixture(`${GOOD_REUSE_AUDIT}\n${emptyShape}\n`);
  const errors = reuseAudit.validateArtifacts(tasksDir);
  assert.ok(
    errors.some((e) => /no decision rows/i.test(e)),
    `expected empty-table error, got: ${JSON.stringify(errors)}`
  );
  cleanup(root);
});

test('Component Shape table accepts an N/A row when no UI components are added', () => {
  const naShape = [
    '## Component Shape Decision',
    '',
    '| Proposed component | Data inputs | Could be agnostic? | Decision | Rationale |',
    '|---|---|---|---|---|',
    '| — | — | — | **N/A** | No new UI components in this spec |',
    '',
  ].join('\n');
  const { root, tasksDir } = fixture(`${GOOD_REUSE_AUDIT}\n${naShape}\n`);
  const errors = reuseAudit.validateArtifacts(tasksDir);
  assert.equal(errors.length, 0, `expected no errors, got: ${JSON.stringify(errors)}`);
  cleanup(root);
});

test('original minimal Reuse Audit (no broad-search evidence) is rejected', () => {
  // This is the shape that shipped the 6-Lineage-component incident: present
  // section, narrow content, no codebase or provider scan.
  const minimal = [
    '## Reuse Audit',
    '',
    '- `components/foo/Bar.tsx` — covers the empty-state pattern.',
    '',
  ].join('\n');
  const { root, tasksDir } = fixture(`${minimal}\n${GOOD_COMPONENT_SHAPE}\n`);
  const errors = reuseAudit.validateArtifacts(tasksDir);
  assert.ok(errors.length >= 1, 'expected at least one error');
  assert.ok(errors.some((e) => /codebase-search/i.test(e)));
  assert.ok(errors.some((e) => /ticket-keyword-search|Linear|Jira/i.test(e)));
  cleanup(root);
});

test('BLOCKS when a Component Shape row has an unrecognised Decision (typo / malformed cell)', () => {
  // Regression: the unknown-decision check used to sit inside the
  // `if (!row.isSpecificOnly) continue` guard, so rows with malformed
  // decisions (e.g. "Maybe", "TBD") silently passed the gate.
  const malformed = [
    '## Component Shape Decision',
    '',
    '| Proposed | Data | Other pages? | Decision | Rationale |',
    '|---|---|---|---|---|',
    '| `Thing` | `data` | unsure | Maybe | not sure yet |',
    '',
  ].join('\n');
  const { root, tasksDir } = fixture(`${GOOD_REUSE_AUDIT}\n${malformed}`);
  const errors = reuseAudit.validateArtifacts(tasksDir);
  assert.ok(
    errors.some((e) => /unrecognised Decision cell/i.test(e) && /Maybe/.test(e)),
    `expected unrecognised-decision error, got: ${JSON.stringify(errors)}`
  );
  cleanup(root);
});

test('hasComponentShapeRow ignores separator rows', () => {
  const headerOnly = ['| a | b | c | d | e |', '|---|---|---|---|---|'].join('\n');
  assert.equal(reuseAudit.hasComponentShapeRow(headerOnly), false);
  const withRow = `${headerOnly}\n| x | y | z | **Generic** | reason |`;
  assert.equal(reuseAudit.hasComponentShapeRow(withRow), true);
});

// ---------- Rationale-quality check ----------

function buildShapeRow({
  name = 'WorkbookSidebar',
  decision = '**Specific-only**',
  rationale = 'depends on page-local hook `useWorkbookCtx`',
} = {}) {
  return [
    '## Component Shape Decision',
    '',
    '| Proposed | Data | Other pages? | Decision | Rationale |',
    '|---|---|---|---|---|',
    `| \`${name}\` | \`{x}\` | No | ${decision} | ${rationale} |`,
    '',
  ].join('\n');
}

test('REJECTS Specific-only rationale that says "would force a cross-cutting change" (ECHO-4466 verbatim)', () => {
  const shape = buildShapeRow({
    rationale: 'would force a cross-cutting change to the asset-level file',
  });
  const { root, tasksDir } = fixture(`${GOOD_REUSE_AUDIT}\n${shape}`);
  const errors = reuseAudit.validateArtifacts(tasksDir);
  assert.ok(
    errors.some((e) => /non-technical rationale/i.test(e) && /cross-cutting/i.test(e)),
    `expected rationale-quality error, got: ${JSON.stringify(errors)}`
  );
  cleanup(root);
});

test('REJECTS Specific-only rationale citing "out of scope"', () => {
  const shape = buildShapeRow({ rationale: 'extracting is out of scope for this ticket' });
  const { root, tasksDir } = fixture(`${GOOD_REUSE_AUDIT}\n${shape}`);
  const errors = reuseAudit.validateArtifacts(tasksDir);
  assert.ok(errors.some((e) => /non-technical rationale/i.test(e)));
  cleanup(root);
});

test('REJECTS "would force a refactor" / "would require the refactoring" (article between verb and object)', () => {
  // Cursor regression: the previous regex required the object word to come
  // immediately after the verb, so natural phrasings with articles ("a",
  // "the", "some") slipped through. Mirrors the article-allowance in defer.
  for (const phrase of [
    'would force a refactor of multiple call sites',
    'would require the refactoring of shared/',
    'would force some modification of the asset-level file',
    'would require a change to the existing component',
  ]) {
    const shape = buildShapeRow({ rationale: phrase });
    const { root, tasksDir } = fixture(`${GOOD_REUSE_AUDIT}\n${shape}`);
    const errors = reuseAudit.validateArtifacts(tasksDir);
    assert.ok(
      errors.some((e) => /non-technical rationale/i.test(e)),
      `expected rejection for "${phrase}", got: ${JSON.stringify(errors)}`
    );
    cleanup(root);
  }
});

test('REJECTS Specific-only rationale citing "too risky" / "premature abstraction" / "deferred"', () => {
  for (const phrase of [
    'this is too risky right now',
    'premature abstraction',
    'deferred to a future ticket',
  ]) {
    const shape = buildShapeRow({ rationale: phrase });
    const { root, tasksDir } = fixture(`${GOOD_REUSE_AUDIT}\n${shape}`);
    const errors = reuseAudit.validateArtifacts(tasksDir);
    assert.ok(
      errors.some((e) => /non-technical rationale/i.test(e)),
      `expected rejection for "${phrase}", got: ${JSON.stringify(errors)}`
    );
    cleanup(root);
  }
});

test('ACCEPTS Specific-only rationale that names a concrete technical constraint', () => {
  const shape = buildShapeRow({
    rationale: 'depends on the page-local `useWorkbookCtx` hook which cannot be lifted to shared/',
  });
  const { root, tasksDir } = fixture(`${GOOD_REUSE_AUDIT}\n${shape}`);
  const errors = reuseAudit.validateArtifacts(tasksDir);
  assert.equal(errors.length, 0, `expected no errors, got: ${JSON.stringify(errors)}`);
  cleanup(root);
});

test('does NOT apply rationale check to Generic-split rows', () => {
  const shape = [
    '## Component Shape Decision',
    '',
    '| Proposed | Data | Other pages? | Decision | Rationale |',
    '|---|---|---|---|---|',
    '| `UsersTable` | `users[]` | Yes | **Split: Generic `Table` + Specific `UsersTable`** | would force a cross-cutting change |',
    '',
  ].join('\n');
  // Even though "would force a cross-cutting change" is in the rationale,
  // the decision is Generic-split so the check should be skipped.
  const { root, tasksDir } = fixture(`${GOOD_REUSE_AUDIT}\n${shape}`);
  const errors = reuseAudit.validateArtifacts(tasksDir);
  assert.equal(errors.length, 0, `expected no errors, got: ${JSON.stringify(errors)}`);
  cleanup(root);
});

// ---------- Cross-spec conflict scan ----------

test('REJECTS Specific-only when sibling spec also declares Specific-only for same stem', () => {
  // Build two specs side by side under the same TASKS_BASE.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-audit-cross-'));
  const tasksBase = path.join(root, 'tasks');
  const aDir = path.join(tasksBase, 'ECHO-1001');
  const bDir = path.join(tasksBase, 'ECHO-1002');
  fs.mkdirSync(aDir, { recursive: true });
  fs.mkdirSync(bDir, { recursive: true });

  const aShape = buildShapeRow({
    name: 'AssetLineageSidebar',
    rationale: 'depends on the page-local `useAssetSelection` hook',
  });
  const bShape = buildShapeRow({
    name: 'TableLineageSidebar',
    rationale: 'depends on the page-local `useTableSelection` hook',
  });
  fs.writeFileSync(path.join(aDir, 'spec.md'), `${GOOD_REUSE_AUDIT}\n${aShape}`);
  fs.writeFileSync(path.join(bDir, 'spec.md'), `${GOOD_REUSE_AUDIT}\n${bShape}`);

  // Validate the second spec — it should see the first as a conflict.
  const errors = reuseAudit.validateArtifacts(bDir);
  assert.ok(
    errors.some(
      (e) => /other in-flight spec/i.test(e) && /Lineage/i.test(e) && /ECHO-1001/.test(e)
    ),
    `expected cross-spec conflict error, got: ${JSON.stringify(errors)}`
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('PASSES when sibling spec exists but uses different stems', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-audit-cross-'));
  const tasksBase = path.join(root, 'tasks');
  const aDir = path.join(tasksBase, 'ECHO-2001');
  const bDir = path.join(tasksBase, 'ECHO-2002');
  fs.mkdirSync(aDir, { recursive: true });
  fs.mkdirSync(bDir, { recursive: true });
  fs.writeFileSync(
    path.join(aDir, 'spec.md'),
    `${GOOD_REUSE_AUDIT}\n${buildShapeRow({ name: 'OrdersTable', rationale: 'page-local hook' })}`
  );
  fs.writeFileSync(
    path.join(bDir, 'spec.md'),
    `${GOOD_REUSE_AUDIT}\n${buildShapeRow({ name: 'CustomersDrawer', rationale: 'page-local hook' })}`
  );
  const errors = reuseAudit.validateArtifacts(bDir);
  assert.equal(errors.length, 0, `expected no cross-spec errors, got: ${JSON.stringify(errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('cross-spec scan skips Generic-split rows in sibling specs', () => {
  // Sibling chose Generic-split — that's the right decision, no conflict.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-audit-cross-'));
  const tasksBase = path.join(root, 'tasks');
  const aDir = path.join(tasksBase, 'ECHO-3001');
  const bDir = path.join(tasksBase, 'ECHO-3002');
  fs.mkdirSync(aDir, { recursive: true });
  fs.mkdirSync(bDir, { recursive: true });
  const aGeneric = [
    '## Component Shape Decision',
    '',
    '| Proposed | Data | Other pages? | Decision | Rationale |',
    '|---|---|---|---|---|',
    '| `AssetLineageSidebar` | `nodes` | Yes | **Split: Generic `LineagePanel` + Specific `AssetLineageSidebar`** | shared shell |',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(aDir, 'spec.md'), `${GOOD_REUSE_AUDIT}\n${aGeneric}`);
  fs.writeFileSync(
    path.join(bDir, 'spec.md'),
    `${GOOD_REUSE_AUDIT}\n${buildShapeRow({ name: 'TableLineageSidebar', rationale: 'page-local hook' })}`
  );
  const errors = reuseAudit.validateArtifacts(bDir);
  assert.equal(errors.length, 0, `expected no errors, got: ${JSON.stringify(errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});
