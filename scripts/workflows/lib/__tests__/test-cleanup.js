/**
 * Shared test cleanup utility.
 *
 * Removes TEST-* directories from TASKS_BASE to prevent leftover
 * test artifacts from accumulating across interrupted test runs.
 *
 * Convention: ALL test ticket IDs MUST start with "TEST-" so this
 * cleanup can safely target them without touching real ticket data.
 *
 * Usage in test files:
 *   const { cleanupTestDirs } = require('../../lib/__tests__/test-cleanup');
 *   before(() => cleanupTestDirs());
 *   after(() => cleanupTestDirs());
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TEST_DIR_PREFIX = 'TEST-';
// Additional test-only patterns that leak into TASKS_BASE because some
// tested functions (e.g., executeTaskReview → appendAction) write to the
// configured TASKS_BASE rather than the injected tasksDir. Extend this list
// rather than letting garbage accumulate.
const EXTRA_TEST_PATTERNS = [
  /^T-\d+$/, // task-review-gate.test.js: T-1..T-14
  /^ARCHIVE-TEST-\d+$/, // complete-deadlock.test.js
];

function isTestDir(name) {
  if (name.startsWith(TEST_DIR_PREFIX)) return true;
  return EXTRA_TEST_PATTERNS.some((re) => re.test(name));
}

function cleanupTestDirs() {
  let tasksBase;
  try {
    const getConfig = require(path.join(__dirname, '..', 'get-config'));
    tasksBase = getConfig('TASKS_BASE');
  } catch {
    return; // TASKS_BASE not configured — nothing to clean
  }
  if (!tasksBase) return;

  try {
    const entries = fs.readdirSync(tasksBase);
    for (const entry of entries) {
      if (isTestDir(entry)) {
        fs.rmSync(path.join(tasksBase, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // Ignore errors — cleanup is best-effort
  }
}

module.exports = { cleanupTestDirs, isTestDir, TEST_DIR_PREFIX, EXTRA_TEST_PATTERNS };
