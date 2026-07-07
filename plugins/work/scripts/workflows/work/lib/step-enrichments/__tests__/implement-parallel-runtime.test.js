/**
 * Dual-runtime tests for the implement enrichment's parallel-dispatch path
 * (WP-08): the dispatch note and per-delegate note route through the vocab
 * tokens, and the delegates render per-runtime.
 *
 * Claude characterization: the override instruction is byte-identical to the
 * pre-vocabulary HEAD literals. Codex: the dispatch line is the serialized
 * [work:codex-degraded] rendering and every delegate is an inline-agent with
 * an on-disk personaPath (C1).
 *
 * Run: node --test scripts/workflows/work/lib/step-enrichments/__tests__/implement-parallel-runtime.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { resetRuntimeCache } = require('../../../../lib/runtime');
const registerImplement = require('../implement');

const ENV_KEYS = ['AGENT_RUNTIME', 'AGENT_RUNTIME_MODE', 'IMPLEMENT_AGENT'];
const saved = {};
let tmp;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetRuntimeCache();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-parallel-rt-'));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetRuntimeCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const TASKS_MD = [
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

function runEnrichment() {
  const handlers = {};
  registerImplement((step, fn) => {
    handlers[step] = fn;
  });
  fs.writeFileSync(path.join(tmp, 'tasks.md'), TASKS_MD);
  const entry = {
    step: 'implement',
    agentType: 'general-purpose',
    agentPrompt: '## Current Task: Task 1 — First thing\n\nTask 1 of 2\n',
  };
  handlers.implement(entry, { ticket: 'GH-9', tasksDir: tmp });
  return entry._overrideInstruction;
}

describe('claude characterization — parallel dispatch byte-identical to HEAD', () => {
  it('note and delegate notes are the HEAD literals', () => {
    process.env.AGENT_RUNTIME = 'claude';
    resetRuntimeCache();
    const instr = runEnrichment();
    assert.ok(instr, 'parallel path produced an override instruction');
    assert.equal(instr.parallel, true);
    assert.equal(instr.delegates.length, 2);
    assert.equal(
      instr.note,
      'Launch ALL 2 agents IN PARALLEL (single message, multiple Task tool calls). Each task is independent.'
    );
    for (const d of instr.delegates) {
      assert.equal(d.type, 'task');
      assert.equal(d.note, 'Pass the prompt directly to the agent.');
      // Schema pin: exactly the HEAD delegate keys.
      assert.deepEqual(Object.keys(d), ['type', 'agentType', 'description', 'prompt', 'note']);
    }
  });
});

describe('codex rendering — serialized inline dispatch (C1)', () => {
  it('dispatch note degrades and delegates become inline-agents', () => {
    process.env.AGENT_RUNTIME = 'codex';
    resetRuntimeCache();
    const instr = runEnrichment();
    assert.ok(instr, 'parallel path produced an override instruction');
    assert.equal(
      instr.note,
      '[work:codex-degraded] parallel dispatch serialized — execute ALL 2 tasks INLINE, one after another. Each task is independent.'
    );
    for (const d of instr.delegates) {
      assert.equal(d.type, 'inline-agent');
      assert.ok(d.personaPath && fs.existsSync(d.personaPath), 'personaPath exists on disk');
      assert.equal(d.note, 'Execute the prompt inline in this session.');
      assert.match(d.notices[0], /^\[work:codex-degraded\]/);
    }
  });
});
