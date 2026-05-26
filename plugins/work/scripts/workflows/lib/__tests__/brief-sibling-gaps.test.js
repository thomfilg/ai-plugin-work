/**
 * Tests for lib/brief-sibling-gaps.js (Gate A parser).
 *
 * Run: node --test scripts/workflows/lib/__tests__/brief-sibling-gaps.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { findUnresolvedSiblingGaps, buildSiblingGapQuestions } = require('../brief-sibling-gaps');

const fixture = (extras = '') => `# Product Brief

## Out of scope (sibling-owned)
- \`app/api/trpc/routers/views.ts\` — owned by ECHO-4552 (status: Done, PR: #1508). Reason: read path missing.
- \`lib/validation/workbook-view.ts\` — owned by ECHO-4552 (status: Done). Reason: schema extension.

${extras}

## Other`;

describe('findUnresolvedSiblingGaps', () => {
  it('returns all entries when no decisions section exists', () => {
    const r = findUnresolvedSiblingGaps(fixture());
    assert.equal(r.outOfScope.length, 2);
    assert.equal(r.decisions.length, 0);
    assert.equal(r.unresolved.length, 2);
    assert.equal(r.unresolved[0].surface, 'app/api/trpc/routers/views.ts');
    assert.equal(r.unresolved[0].ticketId, 'ECHO-4552');
  });

  it('treats entries with matching decisions as resolved', () => {
    const text = fixture(
      '## Sibling-gap decisions\n- `app/api/trpc/routers/views.ts` — decision: wait-for-sibling; timestamp: 2026-05-13T00:00:00Z'
    );
    const r = findUnresolvedSiblingGaps(text);
    assert.equal(r.outOfScope.length, 2);
    assert.equal(r.decisions.length, 1);
    assert.equal(r.unresolved.length, 1);
    assert.equal(r.unresolved[0].surface, 'lib/validation/workbook-view.ts');
  });

  it('matching is case-insensitive on surface', () => {
    const text = fixture(
      '## Sibling-gap decisions\n- `APP/api/trpc/routers/views.ts` — decision: implement-here'
    );
    const r = findUnresolvedSiblingGaps(text);
    assert.equal(r.unresolved.length, 1);
    assert.equal(r.unresolved[0].surface, 'lib/validation/workbook-view.ts');
  });

  it('returns empty for empty / non-string input', () => {
    assert.deepEqual(findUnresolvedSiblingGaps('').unresolved, []);
    assert.deepEqual(findUnresolvedSiblingGaps(null).unresolved, []);
    assert.deepEqual(findUnresolvedSiblingGaps(undefined).unresolved, []);
  });

  it('returns empty when neither section is present', () => {
    const r = findUnresolvedSiblingGaps('# Brief\nNo sibling sections here.');
    assert.equal(r.unresolved.length, 0);
  });

  it('skips empty bullet lines and HTML comments', () => {
    const text = `## Out of scope (sibling-owned)

<!-- a comment -->
- \`a.ts\` — owned by GH-1 (status: Done). Reason: x.

`;
    const r = findUnresolvedSiblingGaps(text);
    assert.equal(r.outOfScope.length, 1);
  });
});

describe('buildSiblingGapQuestions', () => {
  it('produces one user-scoped question per unresolved entry', () => {
    const r = findUnresolvedSiblingGaps(fixture());
    const qs = buildSiblingGapQuestions(r.unresolved, 'ECHO-4553');
    assert.equal(qs.length, 2);
    assert.equal(qs[0].scope, 'user');
    assert.match(qs[0].questionText, /ECHO-4553/);
    assert.match(qs[0].questionText, /ECHO-4552/);
    assert.match(qs[0].questionText, /Implement the gap here.*or complete/);
  });

  it('handles unknown ticketId gracefully', () => {
    const r = findUnresolvedSiblingGaps(
      '## Out of scope (sibling-owned)\n- `surface.ts` — Reason: x.'
    );
    const qs = buildSiblingGapQuestions(r.unresolved, 'GH-1');
    assert.equal(qs.length, 1);
    assert.match(qs[0].questionText, /unknown sibling/);
  });

  it('returns [] for non-array input', () => {
    assert.deepEqual(buildSiblingGapQuestions(null, 'X'), []);
  });
});
