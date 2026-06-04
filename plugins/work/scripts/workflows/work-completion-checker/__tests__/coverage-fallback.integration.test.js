'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readRequirementCoverage } = require('../lib/kind-checks/shared');
const coverageCheck = require('../lib/phases/coverage_check');

function makeTasksDir({ tasks = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-fallback-'));
  const tasksDir = path.join(root, 'ECHO-9999');
  fs.mkdirSync(tasksDir, { recursive: true });
  if (tasks) fs.writeFileSync(path.join(tasksDir, 'tasks.md'), tasks);
  return { root, tasksDir };
}

// Case A — regression - deadlock repro with subsections only
test('regression - deadlock repro with subsections only', () => {
  const tasks = [
    '# Tasks',
    '',
    '## Task 1 — Foo',
    '',
    '### Requirements Covered',
    '- R1',
    '- R2',
    '',
  ].join('\n');
  const { root, tasksDir } = makeTasksDir({ tasks });
  try {
    const rows = readRequirementCoverage(tasksDir);
    assert.equal(rows.length, 2, 'expected 2 synthesized rows from subsections');
    const ids = rows.map((r) => r.id).sort();
    assert.deepEqual(ids, ['R1', 'R2']);
    for (const row of rows) {
      assert.equal(row.status, 'DELIVERED', `row ${row.id} must default to DELIVERED`);
      assert.match(
        row.evidence,
        /tasks\.md:Task 1/,
        `row ${row.id} evidence must reference tasks.md:Task 1`
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Case C — empty table falls back to subsections
test('empty table falls back to subsections', () => {
  const tasks = [
    '# Tasks',
    '',
    '## Requirement Coverage',
    '',
    '| ID | Description | Status | Evidence |',
    '|---|---|---|---|',
    '',
    '## Task 1 — Foo',
    '',
    '### Requirements Covered',
    '- R1',
    '- R2',
    '',
  ].join('\n');
  const { root, tasksDir } = makeTasksDir({ tasks });
  try {
    const rows = readRequirementCoverage(tasksDir);
    assert.equal(rows.length, 2, 'header-only table must fall through to subsection synthesis');
    const ids = rows.map((r) => r.id).sort();
    assert.deepEqual(ids, ['R1', 'R2']);
    for (const row of rows) {
      assert.equal(row.status, 'DELIVERED', `row ${row.id} must default to DELIVERED`);
      assert.match(
        row.evidence,
        /tasks\.md:Task 1/,
        `row ${row.id} evidence must reference tasks.md:Task 1`
      );
    }
    // Header/separator rows must NOT appear as synthesized rows
    assert.equal(
      rows.find((r) => /^(id|requirement|req)$/i.test(r.id) || /^-+$/.test(r.id)),
      undefined,
      'header and separator lines must not be counted as data rows'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Case D — neither table nor subsections present
test('neither table nor subsections present - clear error', () => {
  const tasks = [
    '# Tasks',
    '',
    '## Task 1 — Foo',
    '',
    'Some descriptive content but no requirements coverage anywhere.',
    '',
  ].join('\n');
  const { root, tasksDir } = makeTasksDir({ tasks });
  // Also write a brief.md with a P0 requirement so coverage_check is exercised
  fs.writeFileSync(
    path.join(tasksDir, 'brief.md'),
    ['# Brief', '', '## Requirements', '', '- **P0** must do thing', ''].join('\n')
  );
  try {
    const result = coverageCheck.validate({ tasksDir });
    assert.equal(result.ok, false, 'validate must return ok=false when no coverage source exists');
    assert.ok(Array.isArray(result.errors), 'errors must be an array (ok:false envelope)');
    const blob = result.errors.join('\n');
    assert.match(blob, /split-in-tasks/, 'error message must reference the split-in-tasks step');
    assert.match(
      blob,
      /Requirement Coverage|Requirements Covered/,
      'error message must mention Requirement Coverage or Requirements Covered'
    );
    assert.match(
      blob,
      /Requirement Coverage/,
      'error message must mention `## Requirement Coverage`'
    );
    assert.match(
      blob,
      /Requirements Covered/,
      'error message must mention `### Requirements Covered`'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Case E — coverage_check passes when tasks.md has only subsections
test('coverage_check passes when tasks.md has only subsections', () => {
  const tasks = [
    '# Tasks',
    '',
    '## Task 1 — Foo',
    '',
    '### Requirements Covered',
    '- R1',
    '- R2',
    '',
  ].join('\n');
  const brief = [
    '# Brief',
    '',
    '## Requirements',
    '',
    '- **P0** R1 — must do thing one',
    '- **P0** R2 — must do thing two',
    '',
  ].join('\n');
  const { root, tasksDir } = makeTasksDir({ tasks });
  fs.writeFileSync(path.join(tasksDir, 'brief.md'), brief);
  // Snapshot mtimes so we can assert no writes occurred during validate()
  const tasksMtimeBefore = fs.statSync(path.join(tasksDir, 'tasks.md')).mtimeMs;
  const stateFile = path.join(tasksDir, '.work-state.json');
  const stateExistedBefore = fs.existsSync(stateFile);
  try {
    const result = coverageCheck.validate({ tasksDir });
    assert.equal(
      result.ok,
      true,
      `coverage_check.validate must pass on subsection-only tasks.md; got errors=${JSON.stringify(result.errors)}`
    );
    // Every synthesized row must have status=DELIVERED and non-empty evidence
    const rows = readRequirementCoverage(tasksDir);
    assert.ok(rows.length > 0, 'expected synthesized rows from subsections');
    for (const row of rows) {
      assert.equal(row.status, 'DELIVERED', `row ${row.id} must be DELIVERED`);
      assert.ok(
        row.evidence && row.evidence.trim().length > 0,
        `row ${row.id} must have non-empty evidence`
      );
    }
    // No write to tasks.md or .work-state.json during validate()
    const tasksMtimeAfter = fs.statSync(path.join(tasksDir, 'tasks.md')).mtimeMs;
    assert.equal(tasksMtimeAfter, tasksMtimeBefore, 'tasks.md must not be written by validate()');
    assert.equal(
      fs.existsSync(stateFile),
      stateExistedBefore,
      '.work-state.json must not be created by validate()'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Case B — backward compatibility - top-level table preserved
test('backward compatibility - top-level table preserved', () => {
  const tasks = [
    '# Tasks',
    '',
    '## Requirement Coverage',
    '',
    '| ID | Description | Status | Evidence |',
    '|---|---|---|---|',
    '| R1 | desc | DELIVERED | foo.ts:10 |',
    '',
    '## Task 1 — Foo',
    '',
    '### Requirements Covered',
    '- R99',
    '',
  ].join('\n');
  const { root, tasksDir } = makeTasksDir({ tasks });
  try {
    const rows = readRequirementCoverage(tasksDir);
    assert.equal(rows.length, 1, 'top-level table should be returned verbatim, no fallback');
    assert.deepEqual(rows[0], {
      id: 'R1',
      description: 'desc',
      status: 'DELIVERED',
      evidence: 'foo.ts:10',
      source: 'table',
    });
    // Synthesized rows MUST NOT appear when table has data rows
    assert.equal(
      rows.find((r) => r.id === 'R99'),
      undefined,
      'fallback must not fire when top-level table has data rows'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
