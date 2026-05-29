'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isTestDir,
  isTestSessionGuardLock,
  cleanupSessionGuardLocks,
  cleanupTestArtifacts,
} = require('./test-cleanup');

describe('test-cleanup: dir classification', () => {
  const cases = [
    ['TEST-100', true],
    ['TEST-abc', true],
    ['T-10', true],
    ['T-14', true],
    ['ARCHIVE-TEST-1', true],
    ['ECHO-4446', false], // real ticket — must not match
    ['APPSUPEN-1234', false],
    ['PR-1547', false],
  ];
  for (const [name, expected] of cases) {
    it(`isTestDir(${JSON.stringify(name)}) === ${expected}`, () => {
      assert.equal(isTestDir(name), expected);
    });
  }
});

describe('test-cleanup: session-guard lock classification', () => {
  const cases = [
    // Test-only patterns → should be cleaned
    ['claude-session-guard-TEST-100.json', true],
    ['claude-session-guard-TEST-abc.json', true],
    ['claude-session-guard-T-14.json', true],
    ['claude-session-guard-ARCHIVE-TEST-1.json', true],
    // Garbage patterns from pre-validation bug runs → should be cleaned
    ['claude-session-guard-ECHO-4446 TASKS.json', true],
    ['claude-session-guard-ECHO-4452 SPEC.json', true],
    ['claude-session-guard-ECHO-4452 REWORK=SPEC.json', true],
    // Real ticket lock files → MUST NOT be cleaned
    ['claude-session-guard-ECHO-4446.json', false],
    ['claude-session-guard-APPSUPEN-1234.json', false],
    ['claude-session-guard-PR-1547.json', false],
    // Regression: real tickets whose names contain SPEC/REWORK/TASKS as a
    // substring (INSPECT, PAPERWORK, TASKS-RELATED) must NEVER be matched.
    ['claude-session-guard-INSPECT-123.json', false],
    ['claude-session-guard-PAPERWORK-42.json', false],
    ['claude-session-guard-MULTITASKS-7.json', false],
    // Unrelated files → not touched
    ['some-other-file.json', false],
    ['claude-session-guard-', false], // empty tail
  ];
  for (const [filename, expected] of cases) {
    it(`isTestSessionGuardLock(${JSON.stringify(filename)}) === ${expected}`, () => {
      assert.equal(isTestSessionGuardLock(filename), expected);
    });
  }
});

describe('test-cleanup: cleanupSessionGuardLocks removes only test locks', () => {
  it('removes test-only locks but preserves real-ticket locks', () => {
    // Isolated tmpdir so we don't touch real /tmp content
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
    const origTmpdir = os.tmpdir;
    os.tmpdir = () => tmpDir;
    try {
      const filesToCreate = {
        'claude-session-guard-TEST-100.json': 'should-delete',
        'claude-session-guard-T-14.json': 'should-delete',
        'claude-session-guard-ECHO-4452 SPEC.json': 'should-delete',
        'claude-session-guard-ECHO-4446.json': 'should-keep',
        'claude-session-guard-APPSUPEN-1.json': 'should-keep',
        'unrelated.txt': 'should-keep',
      };
      for (const [name, body] of Object.entries(filesToCreate)) {
        fs.writeFileSync(path.join(tmpDir, name), body);
      }
      cleanupSessionGuardLocks();
      const remaining = fs.readdirSync(tmpDir).sort();
      assert.deepEqual(remaining, [
        'claude-session-guard-APPSUPEN-1.json',
        'claude-session-guard-ECHO-4446.json',
        'unrelated.txt',
      ]);
    } finally {
      os.tmpdir = origTmpdir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('test-cleanup: cleanupTestArtifacts is the union', () => {
  it('does not throw and exposes both leak vectors', () => {
    // Smoke test — both paths are best-effort and tolerant of missing config.
    //
    // IMPORTANT: `cleanupTestArtifacts()` deletes ALL TEST-* dirs from the
    // configured TASKS_BASE. Under `node --test`, test files run concurrently,
    // so invoking it against the real TASKS_BASE here races sibling test files
    // (e.g. enforce-step-workflow.test.js writes TEST-ESW-<pid>-N/.work-state.json
    // and then spawns a hook that reads it; if our cleanup fires between those
    // two steps, the hook sees `stateLoaded:false` and the sibling test fails
    // intermittently — observed as flaky GH-276 terminal-bypass failures in CI).
    //
    // Isolate both leak vectors to disposable tmp dirs so this smoke test cannot
    // touch any other test's state:
    //   - TASKS_BASE → tmp dir (overridden via env, restored in finally)
    //   - os.tmpdir() → tmp dir (overridden, restored in finally)
    const tmpTasks = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-smoke-tasks-'));
    const tmpLocks = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-smoke-locks-'));
    const origTasksBase = process.env.TASKS_BASE;
    const origTmpdir = os.tmpdir;
    process.env.TASKS_BASE = tmpTasks;
    os.tmpdir = () => tmpLocks;
    try {
      assert.doesNotThrow(() => cleanupTestArtifacts());
    } finally {
      if (origTasksBase === undefined) delete process.env.TASKS_BASE;
      else process.env.TASKS_BASE = origTasksBase;
      os.tmpdir = origTmpdir;
      fs.rmSync(tmpTasks, { recursive: true, force: true });
      fs.rmSync(tmpLocks, { recursive: true, force: true });
    }
  });
});
