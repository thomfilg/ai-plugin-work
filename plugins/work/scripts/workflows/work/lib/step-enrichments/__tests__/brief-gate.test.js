/**
 * Tests for step-enrichments/brief-gate.js — Gate 0 manifest validation +
 * pre-existing open-questions handling.
 *
 * Run: node --test scripts/workflows/work/lib/step-enrichments/__tests__/brief-gate.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const registerBriefGate = require('../brief-gate');
const registerQuestionRouter = require('../question-router');

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

/**
 * Register the brief_gate chain in index.js order (GH-543): the brief-gate
 * injector runs first, the question-router routes/batches after it.
 */
function registerChain(reg) {
  registerBriefGate(reg.register);
  registerQuestionRouter(reg.register);
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
    registerChain(reg);
    const entry = { step: 'brief_gate' };
    reg.run('brief_gate', entry, ctx());
    assert.ok(entry._overrideInstruction);
    assert.equal(entry._overrideInstruction.action, 'blocked');
    const qs = entry._overrideInstruction.userQuestions || [];
    assert.equal(qs.length, 1);
    assert.match(qs[0].question, /GH-100/);
  });

  it('injector only merges into the payload — routing is the question-router job (GH-543)', () => {
    fs.writeFileSync(
      path.join(tmp, 'brief.md'),
      [
        '## Out of scope (sibling-owned)',
        '- `lib/x.ts` — owned by GH-100 (status: Done, PR: #50). Reason: read path missing.',
        '',
      ].join('\n')
    );
    const reg = makeRegistry();
    registerBriefGate(reg.register); // injector alone, no router
    const entry = { step: 'brief_gate' };
    reg.run('brief_gate', entry, ctx());
    assert.equal(
      entry._overrideInstruction,
      undefined,
      'the injector must not set _overrideInstruction itself'
    );
    const qs = (entry.askUserQuestionPayload || {}).questions || [];
    assert.equal(qs.length, 1);
    assert.equal(qs[0].kind, 'sibling-gap');
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
    registerChain(reg);
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
    registerChain(reg);
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

describe('brief-gate answers-file transport (GH-543)', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(tmp, 'related-tickets.json'), JSON.stringify(validManifest()));
  });

  function blockedEntry() {
    const reg = makeRegistry();
    registerChain(reg);
    const entry = {
      step: 'brief_gate',
      askUserQuestionPayload: {
        questions: [
          {
            questionText: 'Cross-ticket Q?',
            scope: 'user',
            kind: 'open-question',
            applyKey: 'Cross-ticket Q?',
          },
        ],
      },
    };
    reg.run('brief_gate', entry, ctx());
    assert.ok(entry._overrideInstruction, 'expected blocked override');
    return entry._overrideInstruction;
  }

  it('applyCommand invokes the answers-file CLI with no inline JSON placeholder', () => {
    const override = blockedEntry();
    assert.match(override.applyCommand, /apply-brief-gate-answers\.js/);
    assert.ok(
      override.applyCommand.includes(path.join(tmp, 'brief.md')),
      'applyCommand must carry the brief path'
    );
    assert.ok(
      !override.applyCommand.includes('<JSON_MAP>'),
      'applyCommand must not carry an inline JSON placeholder'
    );
    assert.ok(
      !override.applyCommand.includes('node -e'),
      'applyCommand must not be a node -e one-liner'
    );
  });

  it('hint documents the envelope shape and the answers-file path', () => {
    const override = blockedEntry();
    assert.match(override.hint, /\.brief-gate-answers\.json/);
    assert.match(override.hint, /openQuestions/);
    assert.match(override.hint, /siblingGaps/);
    assert.match(override.hint, /discrepancies/);
    assert.match(override.hint, /work-next\.js/);
  });

  it('userQuestions carry kind and applyKey for envelope routing', () => {
    const override = blockedEntry();
    assert.equal(override.userQuestions.length, 1);
    assert.equal(override.userQuestions[0].kind, 'open-question');
    assert.equal(override.userQuestions[0].applyKey, 'Cross-ticket Q?');
  });

  it('injected sibling-gap questions carry kind/applyKey/options through to userQuestions', () => {
    fs.writeFileSync(
      path.join(tmp, 'brief.md'),
      [
        '## Out of scope (sibling-owned)',
        '- `lib/x.ts` — owned by GH-100 (status: Done, PR: #50). Reason: read path missing.',
        '',
      ].join('\n')
    );
    const reg = makeRegistry();
    registerChain(reg);
    const entry = { step: 'brief_gate' };
    reg.run('brief_gate', entry, ctx());
    assert.ok(entry._overrideInstruction);
    const qs = entry._overrideInstruction.userQuestions;
    assert.equal(qs.length, 1);
    assert.equal(qs[0].kind, 'sibling-gap');
    assert.equal(qs[0].applyKey, 'lib/x.ts');
    assert.deepEqual(qs[0].options, ['implement-here', 'wait-for-sibling']);
  });
});
