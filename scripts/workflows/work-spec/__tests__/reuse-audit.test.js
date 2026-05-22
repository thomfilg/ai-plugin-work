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

test('hasComponentShapeRow ignores separator rows', () => {
  const headerOnly = ['| a | b | c | d | e |', '|---|---|---|---|---|'].join('\n');
  assert.equal(reuseAudit.hasComponentShapeRow(headerOnly), false);
  const withRow = `${headerOnly}\n| x | y | z | **Generic** | reason |`;
  assert.equal(reuseAudit.hasComponentShapeRow(withRow), true);
});
