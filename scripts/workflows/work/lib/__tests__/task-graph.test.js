/**
 * Tests for workflows/work/lib/task-graph.js
 *
 * Focus: Dependencies regex robustness (multi-line bullet lists, single-line, none).
 *
 * Run: node --test scripts/workflows/work/lib/__tests__/task-graph.test.js
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { parseTasks } = require('../task-graph');

function writeTasks(dir, content) {
  fs.writeFileSync(path.join(dir, 'tasks.md'), content);
}

describe('parseTasks — Dependencies regex', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-graph-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Multi-line Dependencies bullet list captures every dependency', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'multi-'));
    writeTasks(
      dir,
      `# Tasks

## Task 1 — First
### Type
backend
### Parallel
No
### Dependencies
None

## Task 2 — Second
### Type
backend
### Parallel
No
### Dependencies
- Task 1

## Task 3 — Third
### Type
backend
### Parallel
No
### Dependencies
- Task 1
- Task 2

## Task 4 — Fourth
### Type
backend
### Parallel
No
### Dependencies
- Task 1
- Task 2
- Task 3
`
    );

    const tasks = parseTasks(dir);
    const t3 = tasks.find((t) => t.num === 3);
    const t4 = tasks.find((t) => t.num === 4);

    assert.deepEqual(t3.dependencies, [1, 2], 'Task 3 should depend on tasks 1 and 2');
    assert.deepEqual(t4.dependencies, [1, 2, 3], 'Task 4 should depend on tasks 1, 2, and 3');
  });

  it('Single-line Dependencies form still parses identically', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'single-'));
    writeTasks(
      dir,
      `# Tasks

## Task 1 — First
### Type
backend
### Parallel
No
### Dependencies
None

## Task 2 — Second
### Type
backend
### Parallel
No
### Dependencies
Task 1, Task 2
`
    );

    const tasks = parseTasks(dir);
    const t2 = tasks.find((t) => t.num === 2);
    assert.deepEqual(t2.dependencies, [1, 2]);
  });

  it('"None" Dependencies value yields empty dependency list', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'none-'));
    writeTasks(
      dir,
      `# Tasks

## Task 1 — Only
### Type
backend
### Parallel
No
### Dependencies
None
`
    );

    const tasks = parseTasks(dir);
    assert.deepEqual(tasks[0].dependencies, []);
  });
});
