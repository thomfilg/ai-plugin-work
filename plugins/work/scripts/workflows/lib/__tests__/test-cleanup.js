/**
 * Shared test cleanup utility.
 *
 * Removes TEST-* directories from TASKS_BASE AND leaked session-guard
 * lock files from /tmp. Test runs that abort (SIGINT, hook rejection,
 * crash) would otherwise leave these around and block future agents.
 *
 * Convention: ALL test ticket IDs MUST start with "TEST-" so this
 * cleanup can safely target them without touching real ticket data.
 *
 * Usage in test files (defense in depth — also called from run-tests.sh
 * trap so interrupted runs clean up):
 *   const { cleanupTestArtifacts } = require('../../lib/__tests__/test-cleanup');
 *   before(() => cleanupTestArtifacts());
 *   after(() => cleanupTestArtifacts());
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_DIR_PREFIX = 'TEST-';
// Additional test-only patterns that leak into TASKS_BASE because some
// tested functions (e.g., executeTaskReview → appendAction) write to the
// configured TASKS_BASE rather than the injected tasksDir. Extend this list
// rather than letting garbage accumulate.
const EXTRA_TEST_PATTERNS = [
  /^T-\d+$/, // task-review-gate.test.js: T-1..T-14
  /^ARCHIVE-TEST-\d+$/, // complete-deadlock.test.js
];

// Session-guard lock files in /tmp. The hook creates these whenever a real
// ticket workflow starts; tests that don't override SESSION_GUARD_DIR will
// leak them. A leaked lock file = a real ticket cannot start its workflow
// until manually rm'd. The patterns below are conservative — they only
// match obvious test-only or garbage-ID lock names; real-ticket locks like
// claude-session-guard-ECHO-4446.json are NEVER deleted by this helper.
const SESSION_GUARD_LOCK_PREFIX = 'claude-session-guard-';
const SESSION_GUARD_TEST_PATTERNS = [
  /^TEST-/, // test-only ticket prefix
  /^T-\d+(?:\.json)?$/, // task-review-gate.test.js series
  /^ARCHIVE-TEST-/, // archive deadlock tests
  // Garbage IDs from pre-validation bug runs always contained a space or '='
  // (real ticket IDs are alphanumeric+hyphen only). This pattern catches them
  // without risking real tickets — INSPECT-123, PAPERWORK-42, etc. are safe
  // because they don't contain either character.
  /[ =]/,
];

function isTestDir(name) {
  if (name.startsWith(TEST_DIR_PREFIX)) return true;
  return EXTRA_TEST_PATTERNS.some((re) => re.test(name));
}

function isTestSessionGuardLock(filename) {
  if (!filename.startsWith(SESSION_GUARD_LOCK_PREFIX)) return false;
  const tail = filename.slice(SESSION_GUARD_LOCK_PREFIX.length);
  return SESSION_GUARD_TEST_PATTERNS.some((re) => re.test(tail));
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

function cleanupSessionGuardLocks() {
  const tmpDir = os.tmpdir() || '/tmp';
  let entries;
  try {
    entries = fs.readdirSync(tmpDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (isTestSessionGuardLock(entry)) {
      try {
        fs.rmSync(path.join(tmpDir, entry), { force: true });
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Run all cleanup tasks (dirs + session-guard locks). Prefer this over
 * cleanupTestDirs alone — it covers every leak vector this helper knows.
 */
function cleanupTestArtifacts() {
  cleanupTestDirs();
  cleanupSessionGuardLocks();
}

module.exports = {
  cleanupTestDirs,
  cleanupSessionGuardLocks,
  cleanupTestArtifacts,
  isTestDir,
  isTestSessionGuardLock,
  TEST_DIR_PREFIX,
  EXTRA_TEST_PATTERNS,
};
