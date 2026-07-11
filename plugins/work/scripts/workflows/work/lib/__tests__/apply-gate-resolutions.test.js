/**
 * Tests for apply-gate-resolutions.js (GH-543, PR1) — the kind-routing
 * persistence library behind the brief_gate answers-file transport.
 *
 * Covers:
 *   - envelope routing per question kind, in parser-round-trip format
 *     (open-questions.parse / findUnresolvedSiblingGaps /
 *     extractRecordedDecisions all see the item as resolved afterwards)
 *   - creation of missing decision sections
 *   - idempotency (double-apply is byte-identical; re-applied keys skipped)
 *   - injection-class answers (single quotes, backticks, newlines, leading #)
 *   - flat string-map back-compat coercion to { openQuestions }
 *   - library-level step guard (refuse only on positive mismatch)
 *
 * Run: node --test scripts/workflows/work/lib/__tests__/apply-gate-resolutions.test.js
 */

'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyGateResolutions, isFullyApplied } = require('../apply-gate-resolutions');
const openQuestions = require('../open-questions');
const { findUnresolvedSiblingGaps } = require('../../../lib/brief-sibling-gaps');
const { extractRecordedDecisions } = require('../../../lib/discrepancy');

const OPEN_Q = 'Which queue backend should we adopt for cross-service jobs?';

const BRIEF_MIXED = [
  '# Brief',
  '',
  '## Open Questions',
  '',
  `- **Question:** ${OPEN_Q}`,
  '  - `scope: architectural`',
  '  - `rationale: affects all downstream services`',
  '  - `resolved: false`',
  '',
  '## Out of scope (sibling-owned)',
  '- `lib/x.ts` — owned by GH-100 (status: Done, PR: #50). Reason: read path missing.',
  '',
].join('\n');

const createdDirs = [];

function makeBrief(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-gate-res-'));
  createdDirs.push(dir);
  const briefPath = path.join(dir, 'brief.md');
  fs.writeFileSync(briefPath, content, 'utf8');
  return { dir, briefPath };
}

function writeState(dir, stepStatus) {
  fs.writeFileSync(path.join(dir, '.work-state.json'), JSON.stringify({ stepStatus }), 'utf8');
}

afterEach(() => {
  while (createdDirs.length) {
    fs.rmSync(createdDirs.pop(), { recursive: true, force: true });
  }
});

describe('applyGateResolutions — kind routing (parser round-trip)', () => {
  it('routes openQuestions to Resolution lines that open-questions.parse sees as resolved', () => {
    const { briefPath } = makeBrief(BRIEF_MIXED);
    const result = applyGateResolutions(briefPath, {
      openQuestions: { [OPEN_Q]: 'Use SQS for all cross-service jobs.' },
    });
    assert.equal(result.changed, true);
    assert.equal(result.refused, null);
    const updated = fs.readFileSync(briefPath, 'utf8');
    const parsed = openQuestions.parse(updated);
    assert.equal(openQuestions.findBlocking(parsed).length, 0, 'question must no longer block');
    const q = parsed.find((p) => p.questionText === OPEN_Q);
    assert.ok(q && q.resolved === true, 'question must be resolved on re-parse');
    assert.match(q.resolution || '', /Use SQS/);
  });

  it('routes siblingGaps to ## Sibling-gap decisions in the format findUnresolvedSiblingGaps parses', () => {
    const { briefPath } = makeBrief(BRIEF_MIXED);
    assert.equal(
      findUnresolvedSiblingGaps(fs.readFileSync(briefPath, 'utf8')).unresolved.length,
      1
    );
    const result = applyGateResolutions(briefPath, {
      siblingGaps: [{ surface: 'lib/x.ts', decision: 'wait-for-sibling' }],
    });
    assert.equal(result.changed, true);
    const updated = fs.readFileSync(briefPath, 'utf8');
    const gaps = findUnresolvedSiblingGaps(updated);
    assert.equal(gaps.unresolved.length, 0, 'gap must be resolved on re-parse');
    assert.equal(gaps.decisions.length, 1);
    assert.equal(gaps.decisions[0].surface, 'lib/x.ts');
    assert.match(updated, /## Sibling-gap decisions/);
    assert.match(updated, /- `lib\/x\.ts` — decision: wait-for-sibling; timestamp: /);
  });

  it('routes discrepancies to ## Discrepancy decisions in the format extractRecordedDecisions parses', () => {
    const { briefPath } = makeBrief(BRIEF_MIXED);
    const result = applyGateResolutions(briefPath, {
      discrepancies: [{ claim: 'lib/legacy.ts', decision: 'out-of-date mention, drop it' }],
    });
    assert.equal(result.changed, true);
    const updated = fs.readFileSync(briefPath, 'utf8');
    const recorded = extractRecordedDecisions(updated);
    assert.ok(recorded.has('lib/legacy.ts'), 'claim must be recorded on re-parse');
    assert.match(updated, /## Discrepancy decisions/);
    assert.match(updated, /- `lib\/legacy\.ts` — out-of-date mention, drop it/);
  });

  it('applies all three kinds from one envelope and reports each key applied', () => {
    const { briefPath } = makeBrief(BRIEF_MIXED);
    const result = applyGateResolutions(briefPath, {
      openQuestions: { [OPEN_Q]: 'Use SQS.' },
      siblingGaps: [{ surface: 'lib/x.ts', decision: 'implement-here' }],
      discrepancies: [{ claim: 'lib/legacy.ts', decision: 'drop it' }],
    });
    assert.equal(result.changed, true);
    assert.equal(result.applied.length, 3);
    assert.deepEqual(result.skipped, []);
    assert.equal(isFullyApplied(result), true);
    const updated = fs.readFileSync(briefPath, 'utf8');
    assert.equal(openQuestions.findBlocking(openQuestions.parse(updated)).length, 0);
    assert.equal(findUnresolvedSiblingGaps(updated).unresolved.length, 0);
    assert.ok(extractRecordedDecisions(updated).has('lib/legacy.ts'));
  });

  it('creates missing decision sections when the brief has none', () => {
    const { briefPath } = makeBrief('# Brief\n\nBody only.\n');
    const result = applyGateResolutions(briefPath, {
      siblingGaps: [{ surface: 'lib/y.ts', decision: 'wait-for-sibling' }],
      discrepancies: [{ claim: 'lib/z.ts', decision: 'keep' }],
    });
    assert.equal(result.changed, true);
    const updated = fs.readFileSync(briefPath, 'utf8');
    assert.match(updated, /## Sibling-gap decisions/);
    assert.match(updated, /## Discrepancy decisions/);
    assert.equal(findUnresolvedSiblingGaps(updated).decisions.length, 1);
    assert.ok(extractRecordedDecisions(updated).has('lib/z.ts'));
  });
});

describe('applyGateResolutions — idempotency', () => {
  it('double-apply is byte-identical and reports keys as already-recorded', () => {
    const { briefPath } = makeBrief(BRIEF_MIXED);
    const envelope = {
      openQuestions: { [OPEN_Q]: 'Use SQS.' },
      siblingGaps: [{ surface: 'lib/x.ts', decision: 'implement-here' }],
      discrepancies: [{ claim: 'lib/legacy.ts', decision: 'drop it' }],
    };
    const first = applyGateResolutions(briefPath, envelope);
    assert.equal(first.changed, true);
    const afterFirst = fs.readFileSync(briefPath, 'utf8');

    const second = applyGateResolutions(briefPath, envelope);
    assert.equal(second.changed, false);
    assert.equal(second.applied.length, 0);
    assert.equal(second.skipped.length, 3);
    for (const s of second.skipped) assert.equal(s.reason, 'already-recorded');
    assert.equal(isFullyApplied(second), true, 'already-recorded skips count as success');

    const afterSecond = fs.readFileSync(briefPath, 'utf8');
    assert.equal(afterSecond, afterFirst, 'double-apply must be byte-identical');
  });

  it('reports unknown open-question keys as skipped (not already-recorded)', () => {
    const { briefPath } = makeBrief(BRIEF_MIXED);
    const before = fs.readFileSync(briefPath, 'utf8');
    const result = applyGateResolutions(briefPath, {
      openQuestions: { 'A question that is not in the brief?': 'answer' },
    });
    assert.equal(result.changed, false);
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'unknown-question');
    assert.equal(isFullyApplied(result), false);
    assert.equal(fs.readFileSync(briefPath, 'utf8'), before, 'brief.md must be untouched');
  });
});

describe('applyGateResolutions — injection-class answers', () => {
  it('persists answers with single quotes, backticks, newlines, and leading # safely', () => {
    const { briefPath } = makeBrief(BRIEF_MIXED);
    const before = openQuestions.parse(fs.readFileSync(briefPath, 'utf8')).length;
    const nasty = "# Heading\nit's a `tricky` answer\n```\nfenced\n```";
    const result = applyGateResolutions(briefPath, {
      openQuestions: { [OPEN_Q]: nasty },
      siblingGaps: [{ surface: 'lib/x.ts', decision: "don't wait\n## Injected" }],
      discrepancies: [{ claim: 'lib/legacy.ts', decision: "it's fine\n# nope" }],
    });
    assert.equal(result.changed, true);
    const updated = fs.readFileSync(briefPath, 'utf8');
    // Structure preserved: same question count, question resolved, no fences.
    const parsed = openQuestions.parse(updated);
    assert.equal(parsed.length, before, 'question count must survive the rewrite');
    assert.equal(parsed.find((q) => q.questionText === OPEN_Q).resolved, true);
    assert.ok(!updated.includes('```'), 'no markdown fence may survive escaping');
    assert.ok(!/^## Injected/m.test(updated), 'answers must not inject new headings');
    assert.ok(!/^# nope/m.test(updated), 'answers must not inject new headings');
    // Sibling gap + discrepancy still round-trip as resolved.
    assert.equal(findUnresolvedSiblingGaps(updated).unresolved.length, 0);
    assert.ok(extractRecordedDecisions(updated).has('lib/legacy.ts'));
  });
});

describe('applyGateResolutions — flat string-map back-compat', () => {
  it('coerces a flat questionText→answer map to { openQuestions }', () => {
    const { briefPath } = makeBrief(BRIEF_MIXED);
    const result = applyGateResolutions(briefPath, { [OPEN_Q]: 'Use SQS.' });
    assert.equal(result.changed, true);
    const updated = fs.readFileSync(briefPath, 'utf8');
    assert.equal(openQuestions.findBlocking(openQuestions.parse(updated)).length, 0);
  });

  it('coerces a Map to { openQuestions }', () => {
    const { briefPath } = makeBrief(BRIEF_MIXED);
    const result = applyGateResolutions(briefPath, new Map([[OPEN_Q, 'Use SQS.']]));
    assert.equal(result.changed, true);
  });

  it('returns an all-empty result for nullish / empty / primitive payloads without touching brief.md', () => {
    const { briefPath } = makeBrief(BRIEF_MIXED);
    const before = fs.readFileSync(briefPath, 'utf8');
    for (const payload of [undefined, null, {}, 42, 'nope', true]) {
      const result = applyGateResolutions(briefPath, payload);
      assert.equal(result.changed, false);
      assert.equal(result.applied.length, 0);
      assert.equal(result.refused, null);
    }
    assert.equal(fs.readFileSync(briefPath, 'utf8'), before);
  });
});

describe('applyGateResolutions — step guard', () => {
  const envelope = () => ({ openQuestions: { [OPEN_Q]: 'Use SQS.' } });

  it('refuses when .work-state.json shows spec in_progress', () => {
    const { dir, briefPath } = makeBrief(BRIEF_MIXED);
    writeState(dir, { brief: 'completed', brief_gate: 'completed', spec: 'in_progress' });
    const before = fs.readFileSync(briefPath, 'utf8');
    const result = applyGateResolutions(briefPath, envelope());
    assert.equal(result.changed, false);
    assert.equal(result.refused, 'step');
    assert.match(result.message, /brief_gate/);
    assert.match(result.message, /work-next\.js/, 'refusal must point at the repair route');
    assert.equal(fs.readFileSync(briefPath, 'utf8'), before, 'brief.md must be untouched');
  });

  it('allows when brief_gate is in_progress', () => {
    const { dir, briefPath } = makeBrief(BRIEF_MIXED);
    writeState(dir, { brief: 'completed', brief_gate: 'in_progress' });
    const result = applyGateResolutions(briefPath, envelope());
    assert.equal(result.refused, null);
    assert.equal(result.changed, true);
  });

  it('allows when no .work-state.json exists (unit tests / ad-hoc use)', () => {
    const { briefPath } = makeBrief(BRIEF_MIXED);
    const result = applyGateResolutions(briefPath, envelope());
    assert.equal(result.refused, null);
    assert.equal(result.changed, true);
  });

  it('allows when the state file has NO step in_progress (transition window)', () => {
    const { dir, briefPath } = makeBrief(BRIEF_MIXED);
    writeState(dir, { brief: 'completed' });
    const result = applyGateResolutions(briefPath, envelope());
    assert.equal(result.refused, null);
    assert.equal(result.changed, true);
  });

  it('allows when corrupt state shows BOTH brief and brief_gate in_progress (allow-first)', () => {
    const { dir, briefPath } = makeBrief(BRIEF_MIXED);
    writeState(dir, { brief: 'in_progress', brief_gate: 'in_progress' });
    const result = applyGateResolutions(briefPath, envelope());
    assert.equal(result.refused, null, 'corrupt states must fail toward the sanctioned path');
    assert.equal(result.changed, true);
  });
});
