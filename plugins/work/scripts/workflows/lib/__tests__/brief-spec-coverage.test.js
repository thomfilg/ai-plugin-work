/**
 * Tests for lib/brief-spec-coverage.js (Gate B parsers).
 *
 * Run: node --test scripts/workflows/lib/__tests__/brief-spec-coverage.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractP0Ids,
  checkP0Coverage,
  checkSiblingOosRestatement,
} = require('../brief-spec-coverage');

describe('extractP0Ids', () => {
  it('extracts numbered list items under "### Must Have (P0)"', () => {
    const brief = `# Brief\n\n### Must Have (P0)\n\n1. First P0\n2. Second P0\n3. Third P0\n\n### Should Have\n4. Not a P0\n`;
    assert.deepEqual(extractP0Ids(brief), ['1', '2', '3']);
  });

  it('also accepts bulleted `**P0 #N**` style', () => {
    const brief = `### Must Have (P0)\n\n- **P0 #1** — Foo\n- **P0 #2** — Bar\n\n### Other\n`;
    assert.deepEqual(extractP0Ids(brief), ['1', '2']);
  });

  it('stops at the next heading', () => {
    const brief = `### Must Have (P0)\n1. A\n2. B\n## Other\n3. C\n`;
    assert.deepEqual(extractP0Ids(brief), ['1', '2']);
  });

  it('returns [] when no P0 section', () => {
    assert.deepEqual(extractP0Ids('# Brief\nno p0 section'), []);
  });

  it('returns [] for non-string input', () => {
    assert.deepEqual(extractP0Ids(null), []);
    assert.deepEqual(extractP0Ids(undefined), []);
  });
});

describe('checkP0Coverage', () => {
  it('marks every P0 covered when spec mentions each ID', () => {
    const spec = '### P0 #1 design\nfoo\n### P0 #2 design\nbar';
    const r = checkP0Coverage(spec, ['1', '2']);
    assert.deepEqual(r.covered, ['1', '2']);
    assert.deepEqual(r.missing, []);
  });

  it('flags P0s with no spec reference', () => {
    const spec = '### Section P0 #1 only';
    const r = checkP0Coverage(spec, ['1', '2', '3']);
    assert.deepEqual(r.covered, ['1']);
    assert.deepEqual(r.missing.sort(), ['2', '3']);
  });

  it('matches `P0 #N` and `P0 N` forms', () => {
    const spec = 'covers P0 #1\ncovers P0 2';
    const r = checkP0Coverage(spec, ['1', '2']);
    assert.deepEqual(r.missing, []);
  });

  it('handles missing inputs', () => {
    assert.deepEqual(checkP0Coverage(null, ['1']).missing, ['1']);
    assert.deepEqual(checkP0Coverage('foo', null).missing, []);
  });
});

describe('checkSiblingOosRestatement', () => {
  it('passes when brief has no OOS section', () => {
    const r = checkSiblingOosRestatement('# Brief\nNo OOS section', '# Spec');
    assert.equal(r.ok, true);
  });

  it('fails when brief has OOS but spec does not', () => {
    const brief = '## Out of scope (sibling-owned)\n- `x.ts` — owned by GH-1';
    const r = checkSiblingOosRestatement(brief, '# Spec\nno restatement');
    assert.equal(r.ok, false);
    assert.match(r.reason, /missing this section/i);
  });

  it('fails when spec OOS section omits brief entries', () => {
    const brief =
      '## Out of scope (sibling-owned)\n- `x.ts` — owned by GH-1\n- `y.ts` — owned by GH-2';
    const spec = '## Out of scope (sibling-owned)\n- `x.ts` — owned by GH-1';
    const r = checkSiblingOosRestatement(brief, spec);
    assert.equal(r.ok, false);
    assert.equal(r.missingEntries.length, 1);
  });

  it('passes when spec restates all brief OOS entries', () => {
    const brief =
      '## Out of scope (sibling-owned)\n- `x.ts` — owned by GH-1\n- `y.ts` — owned by GH-2';
    const spec =
      '## Out of scope (sibling-owned)\n- `x.ts` — owned by GH-1\n- `y.ts` — owned by GH-2';
    const r = checkSiblingOosRestatement(brief, spec);
    assert.equal(r.ok, true);
  });

  it('matches surfaces case-insensitively', () => {
    const brief = '## Out of scope (sibling-owned)\n- `X.ts` — owned by GH-1';
    const spec = '## Out of scope (sibling-owned)\n- `x.ts` — copied';
    assert.equal(checkSiblingOosRestatement(brief, spec).ok, true);
  });
});
