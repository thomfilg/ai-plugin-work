'use strict';

/** @enum {string} Status constants for app access checks */
// Statuses: READY, NOT_CONFIGURED, ACCESS_FAILED, TEST_FAILED, PASSED
module.exports = Object.freeze({
  READY: 'READY',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  ACCESS_FAILED: 'ACCESS_FAILED',
  TEST_FAILED: 'TEST_FAILED',
  PASSED: 'PASSED',
});
