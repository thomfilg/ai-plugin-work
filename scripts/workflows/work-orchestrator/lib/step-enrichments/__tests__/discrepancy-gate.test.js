/**
 * Tests for discrepancy-gate.js (Gate B' enrichment).
 *
 * Run: node --test scripts/workflows/work-orchestrator/lib/step-enrichments/__tests__/discrepancy-gate.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const registerDiscrepancyGate = require('../discrepancy-gate');

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

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ctx = () => ({ tasksDir: tmp, ticket: 'GH-1', workDir: tmp, path, fs });
const write = (name, body) => fs.writeFileSync(path.join(tmp, name), body);

describe('discrepancy-gate at brief_gate', () => {
  it('injects questions when user-prompt claims are missing from brief', () => {
    write('user-prompt.md', 'Please touch `lib/foo.ts` and call ApiClient.update.');
    write('brief.md', '## Must Have (P0)\nuse `lib/other.ts`');
    const reg = makeRegistry();
    registerDiscrepancyGate(reg.register);
    const entry = { step: 'brief_gate' };
    reg.run('brief_gate', entry, ctx());
    const qs = (entry.askUserQuestionPayload && entry.askUserQuestionPayload.questions) || [];
    assert.ok(qs.length >= 2, 'expected at least 2 discrepancy questions');
    assert.ok(qs.some((q) => /user prompt mentions `lib\/foo\.ts`/i.test(q.questionText)));
    assert.ok(qs.some((q) => /user prompt mentions `apiclient\.update`/i.test(q.questionText)));
  });

  it('skips when brief.md is missing', () => {
    write('user-prompt.md', '`a.ts`');
    const reg = makeRegistry();
    registerDiscrepancyGate(reg.register);
    const entry = { step: 'brief_gate' };
    reg.run('brief_gate', entry, ctx());
    assert.equal(entry.askUserQuestionPayload, undefined);
  });

  it('does not stomp existing _overrideInstruction', () => {
    write('user-prompt.md', '`a.ts`');
    write('brief.md', 'no a.ts here');
    const reg = makeRegistry();
    registerDiscrepancyGate(reg.register);
    const existing = { type: 'work_instruction', action: 'blocked', reason: 'other' };
    const entry = { step: 'brief_gate', _overrideInstruction: existing };
    reg.run('brief_gate', entry, ctx());
    assert.equal(entry._overrideInstruction, existing);
    assert.equal(entry.askUserQuestionPayload, undefined);
  });

  it('skips claims with recorded decisions in lower artifact', () => {
    write('user-prompt.md', '`a.ts`');
    write(
      'brief.md',
      'no mention of a.ts\n## Discrepancy decisions\n- `a.ts` — decision: drop; timestamp: 2026-05-13'
    );
    const reg = makeRegistry();
    registerDiscrepancyGate(reg.register);
    const entry = { step: 'brief_gate' };
    reg.run('brief_gate', entry, ctx());
    const qs = (entry.askUserQuestionPayload && entry.askUserQuestionPayload.questions) || [];
    assert.equal(qs.length, 0);
  });
});

describe('discrepancy-gate at spec_gate', () => {
  it('compares brief and user-prompt against spec', () => {
    write('user-prompt.md', '`lib/a.ts`');
    write('brief.md', 'use `lib/b.ts`');
    write('spec.md', 'spec mentions nothing about a.ts or b.ts');
    const reg = makeRegistry();
    registerDiscrepancyGate(reg.register);
    const entry = { step: 'spec_gate' };
    reg.run('spec_gate', entry, ctx());
    const qs = (entry.askUserQuestionPayload && entry.askUserQuestionPayload.questions) || [];
    assert.ok(qs.length >= 2);
  });
});

describe('discrepancy-gate at implement (tasks check)', () => {
  it('compares all higher artifacts against tasks.md', () => {
    write('user-prompt.md', '`lib/a.ts`');
    write('brief.md', 'use `lib/a.ts`');
    write('spec.md', 'spec uses `lib/a.ts`');
    write('tasks.md', '## Task 1\nuses `lib/totally-different.ts`');
    const reg = makeRegistry();
    registerDiscrepancyGate(reg.register);
    const entry = { step: 'implement' };
    reg.run('implement', entry, ctx());
    const qs = (entry.askUserQuestionPayload && entry.askUserQuestionPayload.questions) || [];
    assert.ok(qs.length > 0);
  });
});
