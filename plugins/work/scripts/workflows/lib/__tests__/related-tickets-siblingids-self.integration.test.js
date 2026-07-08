/**
 * Integration tests for lib/related-tickets.js `siblingIds()` — defensive
 * filtering of `self.id` from a legacy manifest that still lists itself in
 * one or more link buckets.
 *
 * Run: node --test scripts/workflows/lib/__tests__/related-tickets-siblingids-self.integration.test.js
 *
 * Task: GH-415 / task3
 * Requirements: R2, R6, R11
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const rt = require('../related-tickets');

const SELF_ID = 'ECHO-5142';

const baseManifest = () => ({
  self: { id: SELF_ID, title: 'self', status: 'In Progress' },
  parent: null,
  siblings: [],
  blockedBy: [],
  dependsOn: [],
  relatedTo: [],
  fetchedAt: new Date().toISOString(),
});

describe('siblingIds() filters self.id defensively from a legacy manifest', () => {
  it('omits self.id when the legacy siblings array still lists it', () => {
    const m = baseManifest();
    m.siblings = [
      { id: 'GH-280', title: 'real sibling' },
      { id: SELF_ID, title: 'leaked self' },
      { id: 'GH-281', title: 'another sibling' },
    ];

    const ids = rt.siblingIds(m);

    assert.ok(!ids.includes(SELF_ID), `expected self.id "${SELF_ID}" to be filtered, got: ${ids.join(',')}`);
    assert.ok(ids.includes('GH-280'), 'expected GH-280 preserved');
    assert.ok(ids.includes('GH-281'), 'expected GH-281 preserved');
  });

  it('omits self.id even when it leaks across multiple buckets (parent, blockedBy, dependsOn, relatedTo)', () => {
    const m = baseManifest();
    m.parent = { id: SELF_ID, title: 'leaked parent' };
    m.siblings = [{ id: 'GH-300' }];
    m.blockedBy = [{ id: SELF_ID }, { id: 'GH-301' }];
    m.dependsOn = [{ id: SELF_ID }, { id: 'GH-302' }];
    m.relatedTo = [{ id: SELF_ID }, { id: 'GH-303' }];

    const ids = rt.siblingIds(m);

    assert.ok(!ids.includes(SELF_ID), `expected self.id "${SELF_ID}" to be filtered from all buckets, got: ${ids.join(',')}`);
    assert.deepEqual(
      ids.sort(),
      ['GH-300', 'GH-301', 'GH-302', 'GH-303'].sort(),
      'expected all non-self ids preserved'
    );
  });

  it('is null-safe when manifest is null/undefined', () => {
    assert.deepEqual(rt.siblingIds(null), []);
    assert.deepEqual(rt.siblingIds(undefined), []);
  });

  it('is null-safe when manifest.self or manifest.self.id is missing (does not throw, returns siblings as-is)', () => {
    const m = baseManifest();
    delete m.self;
    m.siblings = [{ id: 'GH-400' }];
    const ids = rt.siblingIds(m);
    assert.ok(ids.includes('GH-400'));

    const m2 = baseManifest();
    m2.self = {}; // no id
    m2.siblings = [{ id: 'GH-401' }];
    const ids2 = rt.siblingIds(m2);
    assert.ok(ids2.includes('GH-401'));
  });

  it('happy path: a clean manifest with no self-reference returns all linked ids unchanged', () => {
    const m = baseManifest();
    m.parent = { id: 'GH-200' };
    m.siblings = [{ id: 'GH-280' }, { id: 'GH-281' }];
    m.blockedBy = [{ id: 'GH-290' }];
    m.dependsOn = [{ id: 'GH-291' }];
    m.relatedTo = [{ id: 'GH-292' }];

    const ids = rt.siblingIds(m);

    assert.deepEqual(
      ids.sort(),
      ['GH-200', 'GH-280', 'GH-281', 'GH-290', 'GH-291', 'GH-292'].sort()
    );
    assert.ok(!ids.includes(SELF_ID));
  });
});
