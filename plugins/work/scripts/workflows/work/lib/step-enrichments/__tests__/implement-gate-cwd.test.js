/**
 * Regression: implement-gate must run test commands inside the TICKET's
 * worktree, not whichever shell cwd the PostToolUse hook fired from.
 *
 * Cross-worktree contamination scenario: two shells, two worktrees. Agent
 * A invokes /work ECHO-A from worktreeA. Later, a PostToolUse hook fires
 * for ECHO-B from worktreeA's shell. If the gate falls back to
 * process.cwd(), it runs ECHO-B's test command against worktreeA's source
 * files and writes the (almost always wrong) result into ECHO-B's evidence.
 *
 * This test asserts that runPreImplementTest honors its `workingDir`
 * argument by running a command that records its own pwd.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runPreImplementTest, runTestAndRecord } = require('../implement-gate');

describe('implement-gate: test commands honor workingDir (cross-worktree)', () => {
  it('runPreImplementTest executes test in `workingDir`, not process.cwd()', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cwd-'));
    try {
      const fakeWorktree = path.join(tmpRoot, 'worktree-A');
      const fakeTasksBase = path.join(tmpRoot, 'tasks');
      fs.mkdirSync(fakeWorktree, { recursive: true });
      fs.mkdirSync(fakeTasksBase, { recursive: true });

      // Probe file: the test command writes its $PWD into it. We assert
      // afterwards that the recorded pwd matches the fakeWorktree (i.e. the
      // workingDir passed to the gate), proving the gate did NOT fall back
      // to process.cwd().
      const probe = path.join(tmpRoot, 'recorded-pwd.txt');
      // Force exit 1 so the pre-test is treated as an authentic RED (we only
      // care about WHERE the command runs, not what it returns).
      const testCmd = `pwd > ${probe}; exit 1`;

      runPreImplementTest(
        testCmd,
        'TEST-1234',
        1,
        fakeWorktree, // ← workingDir
        process.env,
        fakeTasksBase,
        'implementation'
      );

      assert.ok(fs.existsSync(probe), 'probe file should have been written');
      const recorded = fs.readFileSync(probe, 'utf8').trim();
      // Use realpathSync on both sides — mkdtempSync paths on macOS go
      // through /var → /private/var symlink.
      assert.equal(
        fs.realpathSync(recorded),
        fs.realpathSync(fakeWorktree),
        `expected pwd=${fakeWorktree}, got ${recorded}`
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('runTestAndRecord executes test in `workingDir`, not process.cwd()', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cwd-'));
    try {
      const fakeWorktree = path.join(tmpRoot, 'worktree-B');
      const fakeTasksBase = path.join(tmpRoot, 'tasks');
      fs.mkdirSync(fakeWorktree, { recursive: true });
      fs.mkdirSync(fakeTasksBase, { recursive: true });

      const probe = path.join(tmpRoot, 'recorded-pwd-2.txt');
      // Force exit 0 so the gate would record GREEN if it had a tasksDir
      // (which it does). The cwd-recording side effect runs regardless.
      const testCmd = `pwd > ${probe}; true`;

      runTestAndRecord(testCmd, 'TEST-5678', 1, fakeWorktree, process.env, fakeTasksBase);

      assert.ok(fs.existsSync(probe), 'probe file should have been written');
      const recorded = fs.readFileSync(probe, 'utf8').trim();
      assert.equal(
        fs.realpathSync(recorded),
        fs.realpathSync(fakeWorktree),
        `expected pwd=${fakeWorktree}, got ${recorded}`
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
