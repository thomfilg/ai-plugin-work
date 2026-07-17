'use strict';

/**
 * GH-756: in outcome mode the implement dispatch prompt tells the agent to
 * develop FREELY (no phase machine, no task-next.js) and carries the
 * previous boundary's contradiction as ADVISORY guidance. Process mode
 * keeps the self-paced TDD prompt unchanged.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registerImplement = require('../implement');

let TASKS_DIR;
const handlers = {};
registerImplement((name, fn) => {
  handlers[name] = fn;
});

const TASKS_MD = [
  '## Task 1 — Build the thing',
  '### Type',
  'backend',
  '### Files in scope',
  '- src/**',
  '### Dependencies',
  'None',
  '',
].join('\n');

before(() => {
  TASKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-outcome-prompt-'));
  fs.writeFileSync(path.join(TASKS_DIR, 'tasks.md'), TASKS_MD);
});
after(() => {
  fs.rmSync(TASKS_DIR, { recursive: true, force: true });
  delete process.env.WORK_TDD_MODE;
});
beforeEach(() => {
  delete process.env.WORK_TDD_MODE;
});

function enrich() {
  const entry = { agentPrompt: '## Current Task: Task 1 — Build the thing' };
  handlers.implement(entry, { ticket: 'TEST-1', tasksDir: TASKS_DIR });
  return entry;
}

describe('implement dispatch prompt in outcome mode (GH-756)', () => {
  it('outcome mode dispatches a free-implementation prompt (no phase machine)', () => {
    process.env.WORK_TDD_MODE = 'outcome';
    const entry = enrich();
    assert.match(entry.agentPrompt, /outcome mode/);
    assert.match(entry.agentPrompt, /Implement the task freely/);
    assert.match(entry.agentPrompt, /verifier checks your COMMITS/);
    assert.doesNotMatch(entry.agentPrompt, /task-next\.js/);
    assert.doesNotMatch(entry.agentPrompt, /RED \/ GREEN \/ REFACTOR/);
  });

  it('injects the previous contradiction as advisory guidance on retry', () => {
    process.env.WORK_TDD_MODE = 'outcome';
    fs.writeFileSync(
      path.join(TASKS_DIR, '.work-state.json'),
      JSON.stringify({ _tddRetryReason: 'outcome verifier: CONTRADICTED (I4) — 0 tests ran' })
    );
    const entry = enrich();
    assert.match(entry.agentPrompt, /Previous boundary verdict \(advisory\)/);
    assert.match(entry.agentPrompt, /0 tests ran/);
    fs.rmSync(path.join(TASKS_DIR, '.work-state.json'));
  });

  it('process mode (default) keeps the self-paced TDD prompt', () => {
    const entry = enrich();
    assert.match(entry.agentPrompt, /task-next\.js/);
    assert.doesNotMatch(entry.agentPrompt, /outcome mode/);
  });
});
