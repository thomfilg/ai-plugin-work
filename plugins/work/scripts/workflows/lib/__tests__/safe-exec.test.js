/**
 * Tests for lib/safe-exec.js — safeExec shell-injection-safe command execution
 *
 * Run: node --test lib/__tests__/safe-exec.test.js
 *
 * These tests are hermetic and cross-platform: they invoke Node itself
 * (via process.execPath) with inline scripts instead of POSIX utilities
 * (echo, printf, true, sh, pwd, sleep), which are not available on Windows.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { safeExec } = require('../safe-exec');

const nodePath = process.execPath;

// ─── Basic execution ────────────────────────────────────────────────────────

describe('safeExec — basic execution', () => {
  it('runs a command and returns trimmed stdout', () => {
    const result = safeExec(nodePath, ['-e', 'console.log("hello world")']);
    assert.equal(result, 'hello world');
  });

  it('passes arguments correctly as separate array elements', () => {
    // Proves args are passed individually by concatenating two argv entries
    const result = safeExec(nodePath, [
      '-e',
      'process.stdout.write(process.argv[1]+"-"+process.argv[2])',
      '--',
      'foo',
      'bar',
    ]);
    assert.equal(result, 'foo-bar');
  });

  it('handles commands with no arguments', () => {
    const result = safeExec(nodePath, ['-e', '']);
    assert.equal(result, '');
  });
});

// ─── Defaults ───────────────────────────────────────────────────────────────

describe('safeExec — defaults', () => {
  it('defaults encoding to utf-8 (returns string, not Buffer)', () => {
    const result = safeExec(nodePath, ['-e', 'console.log("utf8-test")']);
    assert.equal(typeof result, 'string');
    assert.equal(result, 'utf8-test');
  });

  it('applies default timeout of 15000ms', () => {
    // We cannot easily assert the internal timeout value directly,
    // but we can verify a fast command succeeds (does not hang)
    const result = safeExec(nodePath, ['-e', 'console.log("fast")']);
    assert.equal(result, 'fast');
  });
});

// ─── Error / fallback handling ──────────────────────────────────────────────

describe('safeExec — error handling', () => {
  it('returns empty string on error by default', () => {
    const result = safeExec(nodePath, ['-e', 'process.exit(1)']);
    assert.equal(result, '');
  });

  it('returns custom fallback value on error', () => {
    const result = safeExec(nodePath, ['-e', 'process.exit(1)'], { fallback: 'N/A' });
    assert.equal(result, 'N/A');
  });

  it('returns fallback when command does not exist', () => {
    const result = safeExec('__nonexistent_command_abc123__', [], { fallback: 'missing' });
    assert.equal(result, 'missing');
  });
});

// ─── stderr suppression ─────────────────────────────────────────────────────

describe('safeExec — stderr suppression', () => {
  it('does not leak stderr to parent process', () => {
    // Node script writes to both stdout and stderr; safeExec must return only stdout
    const result = safeExec(nodePath, ['-e', 'console.log("ok"); console.error("err")']);
    assert.equal(result, 'ok');
  });
});

// ─── Shell injection safety ────────────────────────────────────────────────

describe('safeExec — shell injection safety', () => {
  it('treats shell metacharacters in args as literal strings', () => {
    const result = safeExec(nodePath, [
      '-e',
      'process.stdout.write(process.argv[1])',
      '--',
      '; echo injected',
    ]);
    assert.equal(result, '; echo injected');
  });
});

// ─── Input validation ──────────────────────────────────────────────────────

describe('safeExec — input validation', () => {
  it('throws TypeError when args is not an array', () => {
    assert.throws(
      () => safeExec('cmd', 'not-array'),
      (err) => err instanceof TypeError && /array of strings/.test(err.message)
    );
  });

  it('throws TypeError when args contains a non-string element', () => {
    assert.throws(
      () => safeExec('cmd', [123]),
      (err) => err instanceof TypeError && /array of strings/.test(err.message)
    );
  });

  it('throws TypeError when args is an object', () => {
    assert.throws(
      () => safeExec('cmd', { 0: 'foo' }),
      (err) => err instanceof TypeError && /array of strings/.test(err.message)
    );
  });

  it('throws TypeError when command is null', () => {
    assert.throws(
      () => safeExec(null),
      (err) => err instanceof TypeError && /non-empty string/.test(err.message)
    );
  });

  it('throws TypeError when command is undefined', () => {
    assert.throws(
      () => safeExec(undefined),
      (err) => err instanceof TypeError && /non-empty string/.test(err.message)
    );
  });

  it('throws TypeError when command is an empty string', () => {
    assert.throws(
      () => safeExec(''),
      (err) => err instanceof TypeError && /non-empty string/.test(err.message)
    );
  });

  it('throws TypeError when command is a number', () => {
    assert.throws(
      () => safeExec(42),
      (err) => err instanceof TypeError && /non-empty string/.test(err.message)
    );
  });
});

// ─── Custom options passthrough ─────────────────────────────────────────────

describe('safeExec — custom options', () => {
  it('accepts custom timeout via opts', () => {
    // A short timeout that still allows a fast command to succeed
    const result = safeExec(nodePath, ['-e', 'console.log("quick")'], { timeout: 5000 });
    assert.equal(result, 'quick');
  });

  it('accepts cwd via opts', () => {
    // Cross-platform (Windows/macOS/Linux): never hard-code /tmp.
    // os.tmpdir() returns the correct platform-specific temp directory
    // (e.g. C:\Users\...\Temp on Windows, /var/folders/... on macOS).
    // macOS tmpdir can be a symlink (/var -> /private/var), so realpathSync
    // both sides of the comparison for a reliable equality check.
    const tmpDir = fs.realpathSync(os.tmpdir());
    const result = safeExec(nodePath, ['-e', 'process.stdout.write(process.cwd())'], {
      cwd: tmpDir,
    });
    assert.equal(fs.realpathSync(result), tmpDir);
  }); // end cwd test — no hardcoded paths anywhere in this test body

  it('returns fallback when command times out', () => {
    const result = safeExec(nodePath, ['-e', 'setTimeout(() => {}, 10000)'], {
      timeout: 1,
      fallback: 'timed-out',
    });
    assert.equal(result, 'timed-out');
  });
});
