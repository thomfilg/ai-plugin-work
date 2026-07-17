/**
 * Wave-attribution dispatch tests (GH-769 Task 14).
 *
 * buildParallelOverride appends a per-delegate `Work-Task: <N>` trailer
 * instruction bound to each delegate's own task number; the single-task
 * (serial) dispatch path carries no attribution block. The trailer key in the
 * instruction is the exact `WORK_TASK_TRAILER` constant from attribution.js so
 * instruction text and the boundary parser can never drift.
 *
 * Run: node --test scripts/workflows/work/lib/step-enrichments/__tests__/implement.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { resetRuntimeCache } = require('../../../../lib/runtime');
const registerImplement = require('../implement');
const { WORK_TASK_TRAILER } = require('../../../../task-verify/collect/attribution');

const ENV_KEYS = ['AGENT_RUNTIME', 'AGENT_RUNTIME_MODE', 'IMPLEMENT_AGENT', 'WORK_TDD_MODE'];
const saved = {};
let tmp;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.AGENT_RUNTIME = 'claude';
  resetRuntimeCache();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-attr-'));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetRuntimeCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const PARALLEL_TASKS_MD = [
  '# Tasks',
  '',
  '## Task 1 — First thing',
  '### Type',
  'backend',
  '### Parallel',
  'Yes',
  '### Dependencies',
  'None',
  '### Files in scope',
  '- src/a.js',
  '',
  '## Task 2 — Second thing',
  '### Type',
  'backend',
  '### Parallel',
  'Yes',
  '### Dependencies',
  'None',
  '### Files in scope',
  '- src/b.js',
  '',
].join('\n');

const SINGLE_TASK_MD = [
  '# Tasks',
  '',
  '## Task 1 — Only thing',
  '### Type',
  'backend',
  '### Dependencies',
  'None',
  '### Files in scope',
  '- src/a.js',
  '',
].join('\n');

function handlers() {
  const h = {};
  registerImplement((step, fn) => {
    h[step] = fn;
  });
  return h;
}

function runParallel() {
  fs.writeFileSync(path.join(tmp, 'tasks.md'), PARALLEL_TASKS_MD);
  const entry = {
    step: 'implement',
    agentType: 'general-purpose',
    agentPrompt: '## Current Task: Task 1 — First thing\n\nTask 1 of 2\n',
  };
  handlers().implement(entry, { ticket: 'GH-9', tasksDir: tmp });
  return entry._overrideInstruction;
}

function runSingle() {
  fs.writeFileSync(path.join(tmp, 'tasks.md'), SINGLE_TASK_MD);
  const entry = {
    step: 'implement',
    agentType: 'general-purpose',
    agentPrompt: '## Current Task: Task 1 — Only thing\n',
  };
  handlers().implement(entry, { ticket: 'GH-9', tasksDir: tmp });
  return entry;
}

describe('wave attribution dispatch (GH-769)', () => {
  it('each delegate prompt carries its own Work-Task trailer instruction', () => {
    const instr = runParallel();
    assert.ok(instr, 'parallel path produced an override instruction');
    assert.equal(instr.delegates.length, 2);
    const prompts = Object.fromEntries(
      instr.delegates.map((d) => {
        const numMatch = d.description.match(/Task (\d+)\//);
        return [numMatch[1], d.prompt];
      })
    );
    assert.match(prompts['1'], /### Commit attribution \(parallel wave\)/);
    assert.match(prompts['1'], /git commit --trailer "Work-Task: 1"/);
    assert.match(prompts['2'], /git commit --trailer "Work-Task: 2"/);
    // Each delegate's instruction is bound to ITS OWN task number.
    assert.ok(!prompts['1'].includes('Work-Task: 2'));
    assert.ok(!prompts['2'].includes('Work-Task: 1'));
  });

  it('the instruction warns of UNVERIFIED degradation', () => {
    const instr = runParallel();
    for (const d of instr.delegates) {
      assert.match(d.prompt, /degrade to UNVERIFIED/);
    }
  });

  it('the trailer key equals WORK_TASK_TRAILER from attribution.js (no drift)', () => {
    const instr = runParallel();
    for (const d of instr.delegates) {
      assert.match(d.prompt, new RegExp(`${WORK_TASK_TRAILER}: \\d`));
    }
    assert.equal(WORK_TASK_TRAILER, 'Work-Task');
  });

  it('the single-task (serial) dispatch prompt carries NO attribution block', () => {
    const entry = runSingle();
    assert.equal(entry._overrideInstruction, undefined, 'no parallel override for a single task');
    assert.ok(!/Commit attribution \(parallel wave\)/.test(entry.agentPrompt));
    assert.ok(!/Work-Task/.test(entry.agentPrompt));
  });

  it('parallel outcome-mode delegates also carry the attribution block', () => {
    process.env.WORK_TDD_MODE = 'outcome';
    const instr = runParallel();
    for (const d of instr.delegates) {
      assert.match(d.prompt, /### Commit attribution \(parallel wave\)/);
    }
  });
});
