/**
 * Tests for task-parser.js — Cross-Task Dependencies parsing (Task 7, R8).
 *
 * Verifies parseTasks() returns crossTaskDeps: string[] on every task,
 * parsed from a new optional `### Cross-Task Dependencies` bullet list.
 * Trailing parenthetical comments after the path are stripped.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { parseTasks } = require(path.join(__dirname, '..', 'task-parser'));

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-parser-xdeps-test-'));
}

function teardown() {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function writeTasksFile(content) {
  fs.writeFileSync(path.join(tmpDir, 'tasks.md'), content, 'utf-8');
}

describe('parseTasks — crossTaskDeps', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('parses Cross-Task Dependencies, strips trailing comment, and defaults [] when absent', () => {
    writeTasksFile(`# Task Plan

## Task 1 — Consumer task

### Type
feature

### Description
Some description.

### Files in scope
- src/consumer.ts

### Cross-Task Dependencies
- src/shared/schema.ts (owned by Task 4)

### Acceptance Criteria
- AC1

### Dependencies
- None

## Task 2 — Independent task

### Type
feature

### Description
No cross deps.

### Files in scope
- src/independent.ts

### Acceptance Criteria
- AC1

### Dependencies
- None
`);

    const tasks = parseTasks(tmpDir);
    assert.ok(Array.isArray(tasks), 'parseTasks should return array');
    assert.equal(tasks.length, 2);

    const t1 = tasks[0];
    const t2 = tasks[1];

    // (a) first task's crossTaskDeps equals ['src/shared/schema.ts'] (comment stripped)
    assert.deepEqual(t1.crossTaskDeps, ['src/shared/schema.ts']);

    // (b) second task's crossTaskDeps is []
    assert.deepEqual(t2.crossTaskDeps, []);

    // (c) other shape properties remain unchanged
    assert.deepEqual(t1.filesInScope, ['src/consumer.ts']);
    assert.deepEqual(t2.filesInScope, ['src/independent.ts']);
    assert.equal(t1.num, 1);
    assert.equal(t2.num, 2);
    assert.equal(t1.type, 'feature');
    assert.equal(t2.type, 'feature');
  });
});
