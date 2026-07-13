/**
 * Tests for step-enrichments/question-router.js (GH-543) — brief_gate
 * question DELIVERY: local/user routing extracted from the brief-gate
 * injector, plus batching to AskUserQuestion's 4-question hard cap.
 *
 * Run: node --test scripts/workflows/work/lib/step-enrichments/__tests__/question-router.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const registerQuestionRouter = require('../question-router');
const { MAX_PER_ASK } = require('../../question-batching');

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

// Placeholder roots — the router never touches the disk.
const FAKE_ROOT = path.join(os.tmpdir(), 'question-router-fake');

function ctx(overrides = {}) {
  return { tasksDir: FAKE_ROOT, workDir: FAKE_ROOT, ticket: 'GH-543', path, ...overrides };
}

function openQ(i) {
  return {
    questionText: `Open Q${i}?`,
    scope: 'user',
    rationale: `open rationale ${i}`,
    kind: 'open-question',
    applyKey: `Open Q${i}?`,
  };
}

function gapQ(i) {
  return {
    questionText: `Gap Q${i}?`,
    scope: 'user',
    rationale: `gap rationale ${i}`,
    kind: 'sibling-gap',
    applyKey: `lib/x${i}.ts`,
    options: ['implement-here', 'wait-for-sibling'],
  };
}

function discQ(i) {
  return {
    questionText: `Disc Q${i}?`,
    scope: 'user',
    rationale: `disc rationale ${i}`,
    kind: 'discrepancy',
    applyKey: `claim-${i}`,
  };
}

function route(questions, entryOverrides = {}) {
  const reg = makeRegistry();
  registerQuestionRouter(reg.register);
  const entry = {
    step: 'brief_gate',
    askUserQuestionPayload: { questions },
    ...entryOverrides,
  };
  reg.run('brief_gate', entry, ctx());
  return entry;
}

describe('question-router batching (GH-543)', () => {
  const SIX_MIXED = [openQ(1), openQ(2), openQ(3), gapQ(1), gapQ(2), discQ(1)];

  it('caps a 6-question mixed-kind set at exactly 4 in the override', () => {
    const entry = route(SIX_MIXED);
    assert.ok(entry._overrideInstruction, 'expected blocked override');
    const qs = entry._overrideInstruction.userQuestions;
    assert.equal(qs.length, MAX_PER_ASK);
    // Front slice, in order, each with index/kind/applyKey
    assert.deepEqual(
      qs.map((q) => q.applyKey),
      ['Open Q1?', 'Open Q2?', 'Open Q3?', 'lib/x1.ts']
    );
    assert.deepEqual(
      qs.map((q) => q.index),
      [1, 2, 3, 4]
    );
    assert.deepEqual(
      qs.map((q) => q.kind),
      ['open-question', 'open-question', 'open-question', 'sibling-gap']
    );
  });

  it('adds questionProgress {total:6, thisBatch:4, remaining:2} for the 6-question set', () => {
    const entry = route(SIX_MIXED);
    assert.deepEqual(entry._overrideInstruction.questionProgress, {
      total: 6,
      thisBatch: 4,
      remaining: 2,
      batchNumber: 1,
      totalBatches: 2,
    });
  });

  it('questionProgress is remaining-set-relative (9 pending renders 1/3)', () => {
    const entry = route([...Array(9).keys()].map((i) => openQ(i + 1)));
    const p = entry._overrideInstruction.questionProgress;
    assert.equal(p.batchNumber, 1);
    assert.equal(p.totalBatches, 3);
    assert.equal(p.remaining, 5);
  });

  it('keeps the reason string byte-identical to the pre-batching pin', () => {
    const entry = route(SIX_MIXED);
    assert.equal(
      entry._overrideInstruction.reason,
      'brief_gate requires user input for cross-ticket questions'
    );
  });

  it('delivers a ≤4 set whole (remaining 0, single batch)', () => {
    const entry = route([openQ(1), gapQ(1)]);
    const override = entry._overrideInstruction;
    assert.equal(override.userQuestions.length, 2);
    assert.deepEqual(override.questionProgress, {
      total: 2,
      thisBatch: 2,
      remaining: 0,
      batchNumber: 1,
      totalBatches: 1,
    });
  });

  it('never exceeds the cap when discrepancy questions ride along', () => {
    const entry = route([discQ(1), discQ(2), discQ(3), discQ(4), discQ(5), discQ(6)]);
    const qs = entry._overrideInstruction.userQuestions;
    assert.equal(qs.length, MAX_PER_ASK);
    assert.ok(qs.every((q) => q.kind === 'discrepancy'));
  });

  it('preserves options on batched sibling-gap questions', () => {
    const entry = route([gapQ(1)]);
    assert.deepEqual(entry._overrideInstruction.userQuestions[0].options, [
      'implement-here',
      'wait-for-sibling',
    ]);
  });

  it('applyCommand is the answers-file CLI with no inline JSON placeholder', () => {
    const entry = route(SIX_MIXED);
    const override = entry._overrideInstruction;
    assert.match(override.applyCommand, /apply-brief-gate-answers\.js/);
    assert.ok(override.applyCommand.includes(path.join(FAKE_ROOT, 'brief.md')));
    assert.ok(!override.applyCommand.includes('<JSON_MAP>'));
    assert.ok(!override.applyCommand.includes('$RESOLUTIONS_JSON'));
    assert.ok(!override.applyCommand.includes('node -e'));
  });

  it('hint documents the batch loop: crash-recovery step 0, ONE call, envelope, re-run', () => {
    const entry = route(SIX_MIXED);
    const hint = entry._overrideInstruction.hint;
    assert.match(hint, /already exists \(crash recovery\)/);
    assert.match(hint, /ONE AskUserQuestion call/);
    assert.match(hint, /never more than 4/);
    assert.match(hint, /\.brief-gate-answers\.json/);
    assert.match(hint, /openQuestions/);
    assert.match(hint, /siblingGaps/);
    assert.match(hint, /discrepancies/);
    assert.match(hint, /work-next\.js/);
    assert.match(hint, /next batch/);
  });

  it('emits the non-blocking note when only local questions are present', () => {
    const entry = route([{ questionText: 'Local Q?', scope: 'local' }]);
    assert.match(entry.agentPrompt || '', /Local Questions/);
    assert.equal(entry._overrideInstruction, undefined);
  });

  it('lists local questions alongside a capped user batch', () => {
    const entry = route([
      { questionText: 'Local Q?', scope: 'local' },
      openQ(1),
      openQ(2),
      openQ(3),
      openQ(4),
      openQ(5),
    ]);
    const override = entry._overrideInstruction;
    assert.deepEqual(override.localQuestions, ['Local Q?']);
    assert.equal(override.userQuestions.length, 4);
    assert.equal(override.questionProgress.total, 5);
  });

  it('defers when another blocker already set _overrideInstruction', () => {
    const preset = { type: 'work_instruction', action: 'blocked', reason: 'gate 0 wins' };
    const entry = route(SIX_MIXED, { _overrideInstruction: preset });
    assert.equal(entry._overrideInstruction, preset, 'router must not replace an earlier blocker');
    assert.equal(entry._overrideInstruction.questionProgress, undefined);
  });

  it('is a no-op without an askUserQuestionPayload', () => {
    const reg = makeRegistry();
    registerQuestionRouter(reg.register);
    const entry = { step: 'brief_gate' };
    reg.run('brief_gate', entry, ctx());
    assert.equal(entry._overrideInstruction, undefined);
    assert.equal(entry.agentType, undefined);
  });

  it('is a no-op for an empty questions list', () => {
    const entry = route([]);
    assert.equal(entry._overrideInstruction, undefined);
  });
});
