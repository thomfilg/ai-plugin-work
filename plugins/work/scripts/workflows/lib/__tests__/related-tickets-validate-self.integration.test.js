/**
 * Integration tests for lib/related-tickets.js `validate()` — self-id rejection
 * across all five link buckets (siblings, blockedBy, dependsOn, relatedTo, parent),
 * plus the P1 copy-hint substring and a happy-path regression guard.
 *
 * Run: node --test scripts/workflows/lib/__tests__/related-tickets-validate-self.integration.test.js
 *
 * Task: GH-415 / task2
 * Requirements: R1, R5, R8, R9, R10
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const rt = require('../related-tickets');

const SELF_ID = 'ECHO-5142';
const COPY_HINT = 'Did you copy this manifest from another ticket?';
const SELF_ERR = 'cannot be its own';

const baseManifest = () => ({
  self: { id: SELF_ID, title: 'self', status: 'In Progress' },
  parent: { id: 'GH-200', title: 'p', status: 'Open' },
  siblings: [],
  blockedBy: [],
  dependsOn: [],
  relatedTo: [],
  fetchedAt: new Date().toISOString(),
});

describe('validate() rejects a manifest with self in siblings', () => {
  it('returns valid=false, names the bucket, and includes the copy-hint', () => {
    const m = baseManifest();
    m.siblings = [{ id: SELF_ID, title: 'leaked self' }];

    const { valid, errors } = rt.validate(m);
    const joined = errors.join('|');

    assert.equal(valid, false);
    assert.match(joined, /siblings/);
    assert.match(joined, new RegExp(SELF_ID));
    assert.match(joined, new RegExp(SELF_ERR));
    assert.match(joined, /Did you copy this manifest from another ticket\?/);
  });
});

describe('validate() rejects a manifest with self in blockedBy', () => {
  it('returns valid=false, names the bucket, and includes the copy-hint', () => {
    const m = baseManifest();
    m.blockedBy = [{ id: SELF_ID }];

    const { valid, errors } = rt.validate(m);
    const joined = errors.join('|');

    assert.equal(valid, false);
    assert.match(joined, /blockedBy/);
    assert.match(joined, new RegExp(SELF_ID));
    assert.match(joined, new RegExp(SELF_ERR));
    assert.ok(joined.includes(COPY_HINT), `expected copy-hint substring; got: ${joined}`);
  });
});

describe('validate() rejects a manifest with self in dependsOn', () => {
  it('returns valid=false, names the bucket, and includes the copy-hint', () => {
    const m = baseManifest();
    m.dependsOn = [{ id: SELF_ID }];

    const { valid, errors } = rt.validate(m);
    const joined = errors.join('|');

    assert.equal(valid, false);
    assert.match(joined, /dependsOn/);
    assert.match(joined, new RegExp(SELF_ID));
    assert.match(joined, new RegExp(SELF_ERR));
    assert.ok(joined.includes(COPY_HINT), `expected copy-hint substring; got: ${joined}`);
  });
});

describe('validate() rejects a manifest with self in relatedTo', () => {
  it('returns valid=false, names the bucket, and includes the copy-hint', () => {
    const m = baseManifest();
    m.relatedTo = [{ id: SELF_ID }];

    const { valid, errors } = rt.validate(m);
    const joined = errors.join('|');

    assert.equal(valid, false);
    assert.match(joined, /relatedTo/);
    assert.match(joined, new RegExp(SELF_ID));
    assert.match(joined, new RegExp(SELF_ERR));
    assert.ok(joined.includes(COPY_HINT), `expected copy-hint substring; got: ${joined}`);
  });
});

describe('validate() rejects a manifest where parent.id equals self.id', () => {
  it('returns valid=false, names the parent bucket, and includes the copy-hint', () => {
    const m = baseManifest();
    m.parent = { id: SELF_ID, title: 'parent equals self' };

    const { valid, errors } = rt.validate(m);
    const joined = errors.join('|');

    assert.equal(valid, false);
    assert.match(joined, /parent/);
    assert.match(joined, new RegExp(SELF_ID));
    assert.match(joined, new RegExp(SELF_ERR));
    assert.ok(joined.includes(COPY_HINT), `expected copy-hint substring; got: ${joined}`);
  });
});

describe('regression — copied manifest containing self is caught at validate, not by manual rm', () => {
  it('catches the leaked self-id at validate() time so no agent-side rm is needed', () => {
    // Simulates the bug-class: an agent copied another ticket's manifest and
    // left the current ticket id in `siblings`. validate() must hard-fail.
    const m = baseManifest();
    m.siblings = [
      { id: 'GH-280', title: 'real sibling', status: 'Done' },
      { id: SELF_ID, title: 'leaked copy of self' },
    ];

    const { valid, errors } = rt.validate(m);
    const joined = errors.join('|');

    assert.equal(valid, false, 'copied-self manifest must be rejected, not silently fixed');
    assert.match(joined, /siblings/);
    assert.match(joined, new RegExp(SELF_ID));
    assert.match(joined, new RegExp(SELF_ERR));
    assert.ok(joined.includes(COPY_HINT), `expected copy-hint substring; got: ${joined}`);
  });
});

describe('happy path — a clean manifest with no self-reference still validates', () => {
  it('returns valid=true with empty errors for a manifest that omits self from all buckets', () => {
    const m = baseManifest();
    m.parent = { id: 'GH-200', title: 'real parent' };
    m.siblings = [{ id: 'GH-280', title: 'sib', status: 'Done', prNumber: 1, surfaces: ['a.js'] }];
    m.blockedBy = [{ id: 'GH-281' }];
    m.dependsOn = [{ id: 'GH-282' }];
    m.relatedTo = [{ id: 'GH-283' }];

    const { valid, errors } = rt.validate(m);
    assert.equal(valid, true, errors.join('; '));
    assert.deepEqual(errors, []);
  });
});
