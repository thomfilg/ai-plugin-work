/**
 * Tests for step-enrichments/brief-gate.js — Gate 0 manifest validation +
 * pre-existing open-questions handling.
 *
 * Run: node --test scripts/workflows/work-orchestrator/lib/step-enrichments/__tests__/brief-gate.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const registerBriefGate = require('../brief-gate');

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

const validManifest = () => ({
  self: { id: 'GH-279' },
  parent: null,
  siblings: [],
  blockedBy: [],
  dependsOn: [],
  relatedTo: [],
  fetchedAt: new Date().toISOString(),
});

let tmp;
let originalEnv;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-gate-'));
  originalEnv = { ...process.env };
  // Force provider to a known value via env so tp.getProviderConfig returns predictably.
  process.env.TICKET_PROVIDER = 'github';
  delete process.env.JIRA_PROJECT_KEY;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = originalEnv;
});

const ctx = (overrides = {}) => ({
  tasksDir: tmp,
  ticket: 'GH-279',
  workDir: tmp,
  path,
  fs,
  ...overrides,
});

describe('brief-gate Gate 0 manifest validation', () => {
  it('blocks when manifest is missing', () => {
    const reg = makeRegistry();
    registerBriefGate(reg.register);
    const entry = { step: 'brief_gate' };
    reg.run('brief_gate', entry, ctx());
    assert.ok(entry._overrideInstruction, 'expected blocker override');
    assert.equal(entry._overrideInstruction.action, 'blocked');
    assert.match(entry._overrideInstruction.reason, /missing/);
  });

  it('blocks when manifest is invalid JSON', () => {
    fs.writeFileSync(path.join(tmp, 'related-tickets.json'), '{not json');
    const reg = makeRegistry();
    registerBriefGate(reg.register);
    const entry = { step: 'brief_gate' };
    reg.run('brief_gate', entry, ctx());
    assert.ok(entry._overrideInstruction);
    assert.match(entry._overrideInstruction.reason, /schema|invalid/);
  });

  it('blocks when manifest fails schema validation', () => {
    fs.writeFileSync(path.join(tmp, 'related-tickets.json'), JSON.stringify({ self: {} }));
    const reg = makeRegistry();
    registerBriefGate(reg.register);
    const entry = { step: 'brief_gate' };
    reg.run('brief_gate', entry, ctx());
    assert.ok(entry._overrideInstruction);
    assert.match(entry._overrideInstruction.reason, /schema|invalid|errors/);
  });

  it('passes when manifest is valid (no open questions)', () => {
    fs.writeFileSync(path.join(tmp, 'related-tickets.json'), JSON.stringify(validManifest()));
    const reg = makeRegistry();
    registerBriefGate(reg.register);
    const entry = { step: 'brief_gate' };
    reg.run('brief_gate', entry, ctx());
    assert.equal(entry._overrideInstruction, undefined);
  });

  it('skips manifest check when provider is none', () => {
    process.env.TICKET_PROVIDER = 'none';
    const reg = makeRegistry();
    registerBriefGate(reg.register);
    const entry = { step: 'brief_gate' };
    reg.run('brief_gate', entry, ctx());
    assert.equal(entry._overrideInstruction, undefined);
  });
});

describe('brief-gate Gate A sibling-gap injection', () => {
  beforeEach(() => {
    // Valid manifest so Gate 0 passes — focus on Gate A injection.
    fs.writeFileSync(path.join(tmp, 'related-tickets.json'), JSON.stringify(validManifest()));
  });

  it('injects user-scoped questions for unresolved sibling-gap entries', () => {
    fs.writeFileSync(
      path.join(tmp, 'brief.md'),
      [
        '## Out of scope (sibling-owned)',
        '- `lib/x.ts` — owned by GH-100 (status: Done, PR: #50). Reason: read path missing.',
        '',
        '## Other',
      ].join('\n')
    );
    const reg = makeRegistry();
    registerBriefGate(reg.register);
    const entry = { step: 'brief_gate' };
    reg.run('brief_gate', entry, ctx());
    assert.ok(entry._overrideInstruction);
    assert.equal(entry._overrideInstruction.action, 'blocked');
    const qs = entry._overrideInstruction.userQuestions || [];
    assert.equal(qs.length, 1);
    assert.match(qs[0].question, /GH-100/);
  });

  it('passes when every gap has a matching decision', () => {
    fs.writeFileSync(
      path.join(tmp, 'brief.md'),
      [
        '## Out of scope (sibling-owned)',
        '- `lib/x.ts` — owned by GH-100. Reason: read path.',
        '',
        '## Sibling-gap decisions',
        '- `lib/x.ts` — decision: wait-for-sibling; timestamp: 2026-05-13T00:00Z',
      ].join('\n')
    );
    const reg = makeRegistry();
    registerBriefGate(reg.register);
    const entry = { step: 'brief_gate' };
    reg.run('brief_gate', entry, ctx());
    assert.equal(entry._overrideInstruction, undefined);
  });

  it('no-op when brief.md is missing', () => {
    const reg = makeRegistry();
    registerBriefGate(reg.register);
    const entry = { step: 'brief_gate' };
    reg.run('brief_gate', entry, ctx());
    assert.equal(entry._overrideInstruction, undefined);
  });
});

describe('brief-gate open-questions handling (regression)', () => {
  beforeEach(() => {
    // Write a valid manifest so the Gate 0 path passes — we want to test the
    // existing open-questions path.
    fs.writeFileSync(path.join(tmp, 'related-tickets.json'), JSON.stringify(validManifest()));
  });

  it('emits local-questions note when only local questions present', () => {
    const reg = makeRegistry();
    registerBriefGate(reg.register);
    const entry = {
      step: 'brief_gate',
      askUserQuestionPayload: {
        questions: [{ questionText: 'Q1?', scope: 'local' }],
      },
    };
    reg.run('brief_gate', entry, ctx());
    assert.match(entry.agentPrompt || '', /Local Questions/);
    assert.equal(entry._overrideInstruction, undefined);
  });

  it('builds blocked override for cross-ticket / user questions', () => {
    const reg = makeRegistry();
    registerBriefGate(reg.register);
    const entry = {
      step: 'brief_gate',
      askUserQuestionPayload: {
        questions: [{ questionText: 'Cross-ticket Q?', scope: 'user' }],
      },
    };
    reg.run('brief_gate', entry, ctx());
    assert.ok(entry._overrideInstruction);
    assert.equal(entry._overrideInstruction.action, 'blocked');
    assert.match(entry._overrideInstruction.reason, /user input/);
  });
});
