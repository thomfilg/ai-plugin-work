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
      if (entry.startsWith(TEST_DIR_PREFIX)) {
        fs.rmSync(path.join(tasksBase, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // Ignore errors — cleanup is best-effort
  }
}

module.exports = { cleanupTestDirs, TEST_DIR_PREFIX };
