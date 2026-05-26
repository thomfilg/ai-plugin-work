/**
 * Tests for lib/discrepancy.js (Gate B').
 *
 * Run: node --test scripts/workflows/lib/__tests__/discrepancy.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractClaims,
  compareClaims,
  buildDiscrepancyQuestions,
  extractRecordedDecisions,
  filterUnresolved,
} = require('../discrepancy');

describe('extractClaims', () => {
  it('extracts backticked tokens', () => {
    const claims = extractClaims('use `lib/foo.ts` and `Bar.baz()`');
    assert.ok(claims.has('lib/foo.ts'));
    assert.ok(claims.has('bar.baz()'));
  });

  it('extracts dotted symbols (api.method form)', () => {
    const claims = extractClaims('Call ApiClient.list to get items.');
    assert.ok(claims.has('apiclient.list'));
  });

  it('normalizes case + strips trailing punctuation', () => {
    const claims = extractClaims('`Foo.ts`,');
    assert.ok(claims.has('foo.ts'));
  });

  it('returns empty set for non-string input', () => {
    assert.equal(extractClaims(null).size, 0);
    assert.equal(extractClaims(undefined).size, 0);
  });
});

describe('compareClaims', () => {
  it('identifies claims missing in lower-precedence', () => {
    const r = compareClaims('`a.ts` `b.ts` `c.ts`', '`a.ts` `b.ts`');
    assert.deepEqual(r.missingInLower, ['c.ts']);
    assert.deepEqual(r.extraInLower, []);
  });

  it('identifies claims invented in lower-precedence', () => {
    const r = compareClaims('`a.ts`', '`a.ts` `b.ts` `c.ts`');
    assert.deepEqual(r.missingInLower, []);
    assert.deepEqual(r.extraInLower.sort(), ['b.ts', 'c.ts']);
  });

  it('returns empty when identical', () => {
    const r = compareClaims('`a.ts` `b.ts`', '`a.ts` `b.ts`');
    assert.deepEqual(r.missingInLower, []);
    assert.deepEqual(r.extraInLower, []);
  });

  it('accepts Set inputs', () => {
    const h = new Set(['x', 'y']);
    const l = new Set(['x']);
    const r = compareClaims(h, l);
    assert.deepEqual(r.missingInLower, ['y']);
  });
});

describe('buildDiscrepancyQuestions', () => {
  it('creates one question per claim with explanatory text', () => {
    const cmp = { missingInLower: ['x.ts'], extraInLower: ['y.ts'] };
    const qs = buildDiscrepancyQuestions(cmp, 'user prompt', 'brief');
    assert.equal(qs.length, 2);
    assert.equal(qs[0].scope, 'user');
    assert.match(qs[0].questionText, /user prompt mentions `x\.ts`/);
    assert.match(qs[0].questionText, /brief/);
    assert.match(qs[1].questionText, /brief introduces `y\.ts`/);
    assert.match(qs[1].questionText, /scope creep/);
  });

  it('returns [] for null comparison', () => {
    assert.deepEqual(buildDiscrepancyQuestions(null, 'a', 'b'), []);
  });
});

describe('extractRecordedDecisions + filterUnresolved', () => {
  it('reads claim tokens from a "## Discrepancy decisions" section', () => {
    const text = `## Discrepancy decisions
- \`a.ts\` — decision: keep; timestamp: 2026-05-13T00:00Z
- \`b.ts\` — decision: drop; timestamp: 2026-05-13T00:00Z
`;
    const decisions = extractRecordedDecisions(text);
    assert.ok(decisions.has('a.ts'));
    assert.ok(decisions.has('b.ts'));
  });

  it('returns empty set when no decisions section', () => {
    assert.equal(extractRecordedDecisions('# Brief').size, 0);
  });

  it('filterUnresolved removes questions with recorded decisions', () => {
    const qs = [
      { questionText: '...', scope: 'user', rationale: 'Discrepancy: claim "a.ts" present' },
      { questionText: '...', scope: 'user', rationale: 'Discrepancy: claim "c.ts" present' },
    ];
    const decisions = new Set(['a.ts']);
    const left = filterUnresolved(qs, decisions);
    assert.equal(left.length, 1);
    assert.match(left[0].rationale, /c\.ts/);
  });

  it('filterUnresolved returns [] for non-array', () => {
    assert.deepEqual(filterUnresolved(null, new Set()), []);
  });
});
