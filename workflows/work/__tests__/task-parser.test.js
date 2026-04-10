/**
 * Tests for task-parser.js
 *
 * Covers parseTasks() and buildTaskPrompt() extracted from work.workflow.js.
 * Uses node:test + node:assert/strict.
 * Run: node --test workflows/work/__tests__/task-parser.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { parseTasks, buildTaskPrompt } = require(path.join(__dirname, '..', 'task-parser'));

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-parser-test-'));
}

function teardown() {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function writeTasksFile(content) {
  fs.writeFileSync(path.join(tmpDir, 'tasks.md'), content, 'utf-8');
}

// ─── parseTasks ─────────────────────────────────────────────────────────────

describe('parseTasks', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('returns null when tasks.md does not exist', () => {
    assert.equal(parseTasks(tmpDir), null);
  });

  it('returns null when tasks.md is empty', () => {
    writeTasksFile('');
    assert.equal(parseTasks(tmpDir), null);
  });

  it('returns null when tasks.md has only whitespace', () => {
    writeTasksFile('   \n\n  ');
    assert.equal(parseTasks(tmpDir), null);
  });

  it('parses a single task with title, type, and acceptance criteria', () => {
    writeTasksFile(`# Task Plan

## Task 1 — Build the widget

### Type
feature

### Acceptance Criteria
- Widget renders correctly
`);
    const tasks = parseTasks(tmpDir);
    assert.ok(tasks);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].num, 1);
    assert.equal(tasks[0].id, 'task_1');
    assert.equal(tasks[0].title, 'Build the widget');
    assert.equal(tasks[0].type, 'feature');
    assert.ok(tasks[0].acceptanceCriteria.includes('Widget renders correctly'));
  });

  it('parses multiple tasks', () => {
    writeTasksFile(`## Task 1 — First task

### Type
feature

## Task 2 — Second task

### Type
bugfix
`);
    const tasks = parseTasks(tmpDir);
    assert.ok(tasks);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].num, 1);
    assert.equal(tasks[0].title, 'First task');
    assert.equal(tasks[1].num, 2);
    assert.equal(tasks[1].title, 'Second task');
    assert.equal(tasks[1].type, 'bugfix');
  });

  it('extracts dependencies from ### Dependencies section', () => {
    writeTasksFile(`## Task 1 — Base

### Type
feature

## Task 2 — Depends on base

### Type
feature

### Dependencies
- Task 1 must be completed first
`);
    const tasks = parseTasks(tmpDir);
    assert.ok(tasks);
    assert.equal(tasks[1].dependencies.length, 1);
    assert.equal(tasks[1].dependencies[0], 1);
  });

  it('extracts requirements covered section', () => {
    writeTasksFile(`## Task 1 — Widget

### Type
feature

### Requirements Covered
- REQ-001: Widget must render
- REQ-002: Widget must be clickable
`);
    const tasks = parseTasks(tmpDir);
    assert.ok(tasks);
    assert.ok(tasks[0].requirementsCovered.includes('REQ-001'));
    assert.ok(tasks[0].requirementsCovered.includes('REQ-002'));
  });

  it('extracts suggested scope section', () => {
    writeTasksFile(`## Task 1 — Widget

### Type
feature

### Suggested Scope
- src/widget.js
- src/widget.test.js
`);
    const tasks = parseTasks(tmpDir);
    assert.ok(tasks);
    assert.ok(tasks[0].suggestedScope.includes('src/widget.js'));
  });

  it('identifies checkpoint tasks', () => {
    writeTasksFile(`## Task 1 — Checkpoint: verify everything

### Type
checkpoint
`);
    const tasks = parseTasks(tmpDir);
    assert.ok(tasks);
    assert.equal(tasks[0].isCheckpoint, true);
  });

  it('identifies checkpoint by title even if type is not checkpoint', () => {
    writeTasksFile(`## Task 1 — Checkpoint review

### Type
feature
`);
    const tasks = parseTasks(tmpDir);
    assert.ok(tasks);
    assert.equal(tasks[0].isCheckpoint, true);
  });

  it('preserves rawContent with reconstructed header', () => {
    writeTasksFile(`## Task 1 — Build it

### Type
feature
`);
    const tasks = parseTasks(tmpDir);
    assert.ok(tasks);
    assert.ok(tasks[0].rawContent.startsWith('## Task 1'));
  });

  it('strips trailing non-task ## sections from body', () => {
    writeTasksFile(`## Task 1 — Widget

### Type
feature

### Acceptance Criteria
- It works

## Requirement Coverage
Some coverage info
`);
    const tasks = parseTasks(tmpDir);
    assert.ok(tasks);
    // The requirement coverage section should be stripped
    assert.ok(!tasks[0].rawContent.includes('Requirement Coverage'));
  });

  it('defaults type to unknown when ### Type is missing', () => {
    writeTasksFile(`## Task 1 — No type task

Some description here
`);
    const tasks = parseTasks(tmpDir);
    assert.ok(tasks);
    assert.equal(tasks[0].type, 'unknown');
  });
});

// ─── buildTaskPrompt ────────────────────────────────────────────────────────

describe('buildTaskPrompt', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('generates prompt with task number and title', () => {
    const task = {
      num: 3,
      title: 'Implement API endpoint',
      rawContent: '## Task 3 — Implement API endpoint\n\n### Type\nfeature',
    };
    const prompt = buildTaskPrompt(task, tmpDir);
    assert.ok(prompt.includes('Task 3'));
    assert.ok(prompt.includes('Implement API endpoint'));
  });

  it('includes rules section', () => {
    const task = { num: 1, title: 'Test', rawContent: 'content' };
    const prompt = buildTaskPrompt(task, tmpDir);
    assert.ok(prompt.includes('### Rules'));
    assert.ok(prompt.includes('Implement ONLY the deliverables'));
  });

  it('includes reference document paths', () => {
    const task = { num: 1, title: 'Test', rawContent: 'content' };
    const prompt = buildTaskPrompt(task, tmpDir);
    assert.ok(prompt.includes(path.join(tmpDir, 'brief.md')));
    assert.ok(prompt.includes(path.join(tmpDir, 'spec.md')));
    assert.ok(prompt.includes(path.join(tmpDir, 'tasks.md')));
  });

  it('includes task raw content in the prompt', () => {
    const task = { num: 1, title: 'Widget', rawContent: '## Task 1 — Widget\nBuild the widget' };
    const prompt = buildTaskPrompt(task, tmpDir);
    assert.ok(prompt.includes('Build the widget'));
  });
});
