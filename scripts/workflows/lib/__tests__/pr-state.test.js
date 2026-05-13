/**
 * Tests for lib/pr-state.js (Gate F detector).
 *
 * Run: node --test scripts/workflows/lib/__tests__/pr-state.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isPrClosedWithoutMerge } = require('../pr-state');

describe('isPrClosedWithoutMerge', () => {
  it('false for missing inputs', () => {
    assert.equal(isPrClosedWithoutMerge(null), false);
    assert.equal(isPrClosedWithoutMerge(undefined), false);
    assert.equal(isPrClosedWithoutMerge({}), false);
    assert.equal(isPrClosedWithoutMerge({ pr: null }), false);
  });

  it('true when state == CLOSED', () => {
    assert.equal(isPrClosedWithoutMerge({ pr: { state: 'CLOSED' } }), true);
    assert.equal(isPrClosedWithoutMerge({ pr: { state: 'closed' } }), true);
  });

  it('false when state == MERGED', () => {
    assert.equal(isPrClosedWithoutMerge({ pr: { state: 'MERGED' } }), false);
    assert.equal(isPrClosedWithoutMerge({ pr: { state: 'merged' } }), false);
  });

  it('false when state == OPEN', () => {
    assert.equal(isPrClosedWithoutMerge({ pr: { state: 'OPEN' } }), false);
  });

  it('honors boolean shape (closed=true, merged=false)', () => {
    assert.equal(isPrClosedWithoutMerge({ pr: { closed: true, merged: false } }), true);
  });

  it('false when merged=true even if closed=true', () => {
    assert.equal(isPrClosedWithoutMerge({ pr: { closed: true, merged: true } }), false);
  });

  it('reads alternate location `_prState`', () => {
    assert.equal(isPrClosedWithoutMerge({ _prState: { state: 'CLOSED' } }), true);
  });
});
