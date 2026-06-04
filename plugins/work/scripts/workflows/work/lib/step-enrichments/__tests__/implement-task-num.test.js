/**
 * Regression tests for step-enrichments/implement.js task-number extraction.
 *
 * Previously the enrichment only matched the "Task N of M" context block,
 * which buildTaskPrompt emits only when allTasks.length > 1. Single-task
 * plans produced "Task null" / "tasknull" in the dispatched prompt.
 *
 * Run: node --test scripts/workflows/work/lib/step-enrichments/__tests__/implement-task-num.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const registerImplement = require('../implement');

function makeRegistry() {
  const byStep = {};
  return {
    register: (step, fn) => {
      if (!byStep[step]) byStep[step] = [];
      byStep[step].push(fn);
    },
    run: (step, entry, ctx) => (byStep[step] || []).forEach((fn) => fn(entry, ctx)),
  };
}

function writeTasks(tasksDir, content) {
  fs.writeFileSync(path.join(tasksDir, 'tasks.md'), content);
}

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-enrich-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('implement enrichment — task number extraction', () => {
  it('single-task plan: dispatched prompt contains real task num (no null/tasknull)', () => {
    writeTasks(
      tmp,
      [
        '## Task 1 — Only task',
        '### Type',
        'backend',
        '### Suggested Scope',
        '- src/foo.js',
        '',
      ].join('\n')
    );

    const registry = makeRegistry();
    registerImplement(registry.register);

    // Mirrors the single-task agentPrompt shape produced by buildTaskPrompt:
    // header is present, but no "Task N of M" context block.
    const entry = {
      agentPrompt: [
        '## Current Task: Task 1 — Only task',
        '',
        'You are implementing ONE task from the task plan.',
      ].join('\n'),
    };

    registry.run('implement', entry, { ticket: 'GH-123', tasksDir: tmp });

    assert.doesNotMatch(entry.agentPrompt, /Task null/, 'no literal "Task null"');
    assert.doesNotMatch(entry.agentPrompt, /tasknull/, 'no literal "tasknull"');
    assert.match(entry.agentPrompt, /## Task 1\b/);
    assert.match(entry.agentPrompt, /\btask1\b/);
    assert.match(entry.agentPrompt, /GH-123 task1/);
  });

  it('multi-task plan: still extracts num + total from "Task N of M" block', () => {
    writeTasks(
      tmp,
      [
        '## Task 2 — Second task',
        '### Type',
        'backend',
        '### Suggested Scope',
        '- src/bar.js',
        '',
      ].join('\n')
    );

    const registry = makeRegistry();
    registerImplement(registry.register);

    const entry = {
      agentPrompt: [
        '## Current Task: Task 2 — Second task',
        '',
        '### Task Context',
        'This is Task 2 of 3. Scope boundaries are listed below to prevent drift:',
      ].join('\n'),
    };

    // tasksDir omitted so the parallel-dispatch branch is skipped and we
    // exercise the single-task prompt assembly path (which is the one that
    // previously interpolated null).
    registry.run('implement', entry, { ticket: 'GH-456', tasksDir: '' });

    assert.doesNotMatch(entry.agentPrompt, /Task null/);
    assert.doesNotMatch(entry.agentPrompt, /tasknull/);
    assert.match(entry.agentPrompt, /## Task 2\/3\b/);
    assert.match(entry.agentPrompt, /GH-456 task2/);
  });
});
