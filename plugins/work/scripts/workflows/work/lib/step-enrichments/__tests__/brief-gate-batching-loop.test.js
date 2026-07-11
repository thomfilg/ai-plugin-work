/**
 * Integration test for the brief_gate batching loop (GH-543).
 *
 * Drives the real planner step (steps/brief-gate.js) + the real enrichment
 * chain in index.js registration order (brief-gate injector → question-router
 * → discrepancy-gate) through a simulated driver loop:
 *
 *   derive → auto-answer the ≤4 batch → apply the envelope → re-derive
 *
 * brief.md is the store of record, so every pass statelessly re-derives the
 * remaining set — the crash-resume test pins that a restart between batches
 * yields the identical next batch.
 *
 * Run: node --test scripts/workflows/work/lib/step-enrichments/__tests__/brief-gate-batching-loop.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { STEPS } = require('../../../step-registry');
const briefGateStep = require('../../../steps/brief-gate.js');
const registerBriefGate = require('../brief-gate');
const registerQuestionRouter = require('../question-router');
const registerDiscrepancyGate = require('../discrepancy-gate');
const { applyGateResolutions } = require('../../apply-gate-resolutions');

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

function briefWith({ open = 0, gaps = 0 }) {
  const lines = ['# Brief', ''];
  if (open > 0) {
    lines.push('## Open Questions', '');
    for (let i = 1; i <= open; i++) {
      lines.push(`- **Question:** Cross-ticket question ${i}?`);
      lines.push('  - `scope: cross-ticket`');
      lines.push(`  - \`rationale: affects sibling ${i}\``);
      lines.push('  - `resolved: false`');
      lines.push('');
    }
  }
  if (gaps > 0) {
    lines.push('## Out of scope (sibling-owned)');
    for (let i = 1; i <= gaps; i++) {
      lines.push(
        `- \`lib/surface-${i}.ts\` — owned by GH-10${i} (status: Open, PR: none). Reason: shared surface ${i}.`
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

let tmp;
let savedProvider;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-gate-loop-'));
  savedProvider = process.env.TICKET_PROVIDER;
  // Skip Gate 0 (related-tickets manifest) — this suite tests question delivery.
  process.env.TICKET_PROVIDER = 'none';
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedProvider === undefined) delete process.env.TICKET_PROVIDER;
  else process.env.TICKET_PROVIDER = savedProvider;
});

/** One planner pass: step decision + enrichment chain in index.js order. */
function derive(dir) {
  const entries = [];
  const add = (step, action, command, reason, extra) =>
    entries.push({ step, action, command, reason, ...(extra || {}) });
  briefGateStep(add, { hasBrief: true }, { STEPS, ticket: 'GH-543', tasksDir: dir, path });
  const entry = entries[0];
  if (entry.action !== 'RUN') return { entry, override: null };
  const reg = makeRegistry();
  registerBriefGate(reg.register);
  registerQuestionRouter(reg.register);
  registerDiscrepancyGate(reg.register);
  reg.run('brief_gate', entry, { tasksDir: dir, ticket: 'GH-543', workDir: dir, path, fs });
  return { entry, override: entry._overrideInstruction || null };
}

/** Auto-answer every question in the batch, routed by kind. */
function answerBatch(override) {
  const envelope = { openQuestions: {}, siblingGaps: [], discrepancies: [] };
  for (const q of override.userQuestions) {
    if (q.kind === 'sibling-gap') {
      envelope.siblingGaps.push({ surface: q.applyKey, decision: 'implement-here' });
    } else if (q.kind === 'discrepancy') {
      envelope.discrepancies.push({ claim: q.applyKey, decision: 'keep as specified' });
    } else {
      envelope.openQuestions[q.applyKey] = `Answered: ${q.applyKey}`;
    }
  }
  return envelope;
}

describe('brief-gate batching loop (GH-543 integration)', () => {
  it('5 open + 3 sibling-gap questions terminate in exactly 2 batches, all 8 persisted', () => {
    const briefPath = path.join(tmp, 'brief.md');
    fs.writeFileSync(briefPath, briefWith({ open: 5, gaps: 3 }), 'utf8');

    const batchSizes = [];
    let guard = 0;
    for (;;) {
      guard += 1;
      assert.ok(guard <= 10, 'driver loop did not terminate');
      const { entry, override } = derive(tmp);
      if (entry.action === 'DEFER') break;
      assert.equal(entry.action, 'RUN');
      assert.ok(override, 'RUN pass must produce a blocked override');
      assert.ok(
        override.userQuestions.length <= 4,
        `batch of ${override.userQuestions.length} exceeds the AskUserQuestion cap`
      );
      batchSizes.push(override.userQuestions.length);
      const result = applyGateResolutions(briefPath, answerBatch(override));
      assert.equal(result.changed, true, 'every batch must persist into brief.md');
    }

    assert.deepEqual(batchSizes, [4, 4], 'expected exactly 2 batches of 4');

    const { entry } = derive(tmp);
    assert.equal(entry.action, 'DEFER');
    assert.match(entry.reason, /All blocking questions resolved/);

    const final = fs.readFileSync(briefPath, 'utf8');
    for (let i = 1; i <= 5; i++) {
      assert.ok(
        final.includes(`Answered: Cross-ticket question ${i}?`),
        `open question ${i} resolution must be persisted`
      );
    }
    for (let i = 1; i <= 3; i++) {
      assert.ok(
        final.includes(`- \`lib/surface-${i}.ts\` — decision: implement-here`),
        `sibling-gap decision ${i} must be persisted`
      );
    }
  });

  it('crash between batches resumes with the identical next batch (stateless re-derive)', () => {
    const briefPath = path.join(tmp, 'brief.md');
    fs.writeFileSync(briefPath, briefWith({ open: 5, gaps: 3 }), 'utf8');

    const first = derive(tmp);
    assert.ok(first.override);
    applyGateResolutions(briefPath, answerBatch(first.override));

    // "Crash" here: no in-memory state survives — every derive() is a fresh
    // pass over brief.md. Two consecutive re-derivations must agree.
    const passA = derive(tmp).override.userQuestions.map((q) => q.applyKey);
    const passB = derive(tmp).override.userQuestions.map((q) => q.applyKey);
    assert.deepEqual(passA, passB, 'restart must resume at the same batch');
    assert.ok(passA.length > 0 && passA.length <= 4);
  });

  it('delivers trailing sibling-gap batches: gate stays RUN when only gaps remain', () => {
    const briefPath = path.join(tmp, 'brief.md');
    fs.writeFileSync(briefPath, briefWith({ open: 0, gaps: 2 }), 'utf8');

    const { entry, override } = derive(tmp);
    assert.equal(entry.action, 'RUN', 'sibling gaps alone must keep the gate RUN, not DEFER');
    assert.ok(
      entry.agentType && entry.agentPrompt,
      'RUN entry must delegate so enrichAndReturn executes the enrichment chain'
    );
    assert.ok(override, 'sibling-gap questions must reach the user');
    assert.equal(override.userQuestions.length, 2);
    assert.ok(override.userQuestions.every((q) => q.kind === 'sibling-gap'));

    const result = applyGateResolutions(briefPath, answerBatch(override));
    assert.equal(result.changed, true);
    assert.equal(derive(tmp).entry.action, 'DEFER');
  });
});
