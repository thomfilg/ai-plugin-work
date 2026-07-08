const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const status = require('../app-access-status');

describe('app-access-status', () => {
  const expectedStatuses = {
    READY: 'READY',
    NOT_CONFIGURED: 'NOT_CONFIGURED',
    ACCESS_FAILED: 'ACCESS_FAILED',
    TEST_FAILED: 'TEST_FAILED',
    PASSED: 'PASSED',
  };

  it('exports exactly five status constants', () => {
    const keys = Object.keys(status);
    assert.equal(keys.length, 5, `Expected 5 constants, got ${keys.length}: ${keys.join(', ')}`);
  });

  for (const [key, value] of Object.entries(expectedStatuses)) {
    it(`exports ${key} as a string with value "${value}"`, () => {
      assert.equal(typeof status[key], 'string', `${key} should be a string`);
      assert.equal(status[key], value);
    });
  }
});
