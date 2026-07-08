'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const shape = require('../lib/component-shape');

const BASE_HEADER = [
  '## Component Shape Decision',
  '',
  '| Proposed | Data | Other pages? | Decision | Rationale |',
  '|---|---|---|---|---|',
].join('\n');

function specWithRows(rows) {
  return `# Spec\n\n${BASE_HEADER}\n${rows.join('\n')}\n`;
}

test('parses Generic-split row and extracts generic + specific names', () => {
  const text = specWithRows([
    '| `UsersTable` | `users[]` | Yes | **Split: Generic `Table` + Specific `UsersTable`** | shared shell |',
  ]);
  const { found, rows } = shape.parseShapeSection(text);
  assert.equal(found, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isGenericSplit, true);
  assert.equal(rows[0].genericName, 'Table');
  assert.equal(rows[0].specificName, 'UsersTable');
});

test('parses Specific-only row', () => {
  const text = specWithRows([
    '| `WorkbookSidebar` | `wb` | No | **Specific-only** | depends on page-local hook `useWorkbookCtx` |',
  ]);
  const { rows } = shape.parseShapeSection(text);
  assert.equal(rows[0].isSpecificOnly, true);
  assert.equal(rows[0].isGenericSplit, false);
});

test('parses N/A row', () => {
  const text = specWithRows(['| — | — | — | **N/A** | No new UI components |']);
  const { rows } = shape.parseShapeSection(text);
  assert.equal(rows[0].isNA, true);
});

test('classifies unknown decision', () => {
  assert.equal(shape.classifyDecision('???'), 'unknown');
  assert.equal(shape.classifyDecision('Generic'), 'genericSplit');
  assert.equal(shape.classifyDecision('Specific only'), 'specificOnly');
  assert.equal(shape.classifyDecision('n/a'), 'na');
});

test('extractStem drops common role suffixes', () => {
  assert.equal(shape.extractStem('ExternalAssetLineage'), 'Lineage');
  assert.equal(shape.extractStem('UsersTable'), 'Users');
  assert.equal(shape.extractStem('LineageSidebar'), 'Lineage');
  assert.equal(shape.extractStem('Breadcrumb'), 'Breadcrumb'); // role-only name keeps itself
});

test('returns found=false when section is missing', () => {
  const { found, rows } = shape.parseShapeSection('# Spec\n\nNo decision section here.');
  assert.equal(found, false);
  assert.equal(rows.length, 0);
});

test('tolerates loose formatting (no backticks, no bold)', () => {
  const text = specWithRows([
    '| LineageSidebar | nodes | Yes | Split: Generic LineagePanel + Specific LineageSidebar | shared layout |',
  ]);
  const { rows } = shape.parseShapeSection(text);
  assert.equal(rows[0].isGenericSplit, true);
  assert.equal(rows[0].genericName, 'LineagePanel');
  assert.equal(rows[0].specificName, 'LineageSidebar');
});
