'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('intentionally failing test', () => {
  it('should fail', () => {
    assert.strictEqual(1, 2, 'This test is meant to fail');
  });
});
