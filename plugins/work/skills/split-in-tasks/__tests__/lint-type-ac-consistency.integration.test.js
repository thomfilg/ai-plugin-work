'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE_PATH = path.resolve(__dirname, '..', 'lib', 'lint-type-ac-consistency.js');

function buildTaskModel({ type, acLines, taskNumber = 1, file = 'tasks.md' }) {
  const sectionLines = [
    `## Task ${taskNumber} — sample`,
    '',
    '### Type',
    type,
    '',
    '### Acceptance Criteria',
    ...acLines.map((line) => `- ${line}`),
    '',
  ];
  return {
    file,
    tasks: [
      {
        number: taskNumber,
        section: sectionLines.join('\n'),
        acceptanceCriteria: acLines,
      },
    ],
  };
}

describe('split-in-tasks recognises every canonical docs-exemption phrase', () => {
  const cases = [
    {
      name: 'documentation exempt',
      ac: 'This task is documentation exempt and ships docs only.',
    },
    {
      name: 'docs-only',
      ac: 'docs-only update; no behaviour change.',
    },
    {
      name: 'no RED/GREEN/REFACTOR cycle required',
      ac: 'no RED/GREEN/REFACTOR cycle required for this change.',
    },
    {
      name: 'documentation/manifest only',
      ac: 'documentation/manifest only — no behaviour change.',
    },
    {
      name: 'config-only',
      ac: 'config-only edit to package.json.',
    },
    {
      name: 'manifest-only',
      ac: 'manifest-only update of plugin.json.',
    },
    {
      name: 'no testable surface',
      ac: 'this change has no testable surface.',
    },
  ];

  for (const c of cases) {
    it(`flags Type=wiring + AC "${c.name}" as kind-D SPLIT-WARNING`, () => {
      const { lintTypeAcConsistency } = require(MODULE_PATH);
      const model = buildTaskModel({
        type: 'wiring',
        acLines: [c.ac],
        taskNumber: 7,
        file: 'tasks.md',
      });
      const result = lintTypeAcConsistency(model);
      assert.ok(result, 'expected a warning record, got null/undefined');
      assert.equal(result.kind, 'D', 'expected kind === "D"');
      assert.equal(result.file, 'tasks.md');
      assert.equal(result.hint, 'propose Type: docs');
      assert.match(result.message, /task\s*7/i, 'message should name the task number');
      assert.ok(
        result.message.includes(c.ac) || result.message.toLowerCase().includes(c.ac.toLowerCase()),
        'message should include the offending AC line'
      );
      assert.match(result.message, /wiring/i, 'message should name the declared Type');
    });
  }

  it('returns null on the Type=docs happy path', () => {
    const { lintTypeAcConsistency } = require(MODULE_PATH);
    const model = buildTaskModel({
      type: 'docs',
      acLines: ['documentation/manifest only — no RED/GREEN/REFACTOR cycle required'],
    });
    const result = lintTypeAcConsistency(model);
    assert.equal(result, null, 'expected null when Type=docs');
  });
});

describe('docs-exemption phrases suppress warnings when Type aligns', () => {
  const alignedCases = [
    { type: 'config', ac: 'config-only edit to package.json.' },
    { type: 'file-move', ac: 'manifest-only update of plugin.json.' },
    { type: 'config', ac: 'manifest-only update of plugin.json.' },
    {
      type: 'file-move',
      ac: 'no RED/GREEN/REFACTOR cycle required for this change.',
    },
    {
      type: 'mechanical-refactor',
      ac: 'this change has no testable surface.',
    },
    { type: 'ci', ac: 'no RED/GREEN cycle required.' },
  ];

  for (const c of alignedCases) {
    it(`suppresses warning for Type=${c.type} + AC "${c.ac}"`, () => {
      const { lintTypeAcConsistency } = require(MODULE_PATH);
      const model = buildTaskModel({ type: c.type, acLines: [c.ac] });
      const result = lintTypeAcConsistency(model);
      assert.equal(
        result,
        null,
        `expected no warning when Type=${c.type} aligns with exempt phrase`
      );
    });
  }

  it('still warns when Type does not align with the phrase (config-only + Type=file-move)', () => {
    const { lintTypeAcConsistency } = require(MODULE_PATH);
    const model = buildTaskModel({
      type: 'file-move',
      acLines: ['config-only edit to package.json.'],
    });
    const result = lintTypeAcConsistency(model);
    assert.ok(result, 'expected a warning when Type=file-move + config-only AC');
    assert.equal(result.kind, 'D');
    assert.equal(result.hint, 'propose Type: docs');
  });
});
