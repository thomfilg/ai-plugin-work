const { describe, it, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('hook-error-log', () => {
  let tmpFile;
  let savedDebug;
  let savedLogFile;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `hook-error-test-${process.pid}-${Date.now()}.log`);
    savedDebug = process.env.ENFORCE_HOOK_DEBUG;
    savedLogFile = process.env.HOOK_ERROR_LOG;
    process.env.HOOK_ERROR_LOG = tmpFile;
    // Reset the cached _logFd and module state by re-requiring the module
    delete require.cache[require.resolve('../hook-error-log')];
  });

  afterEach(() => {
    // Re-require to get a reference so we can clean up, then clear cache
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    if (savedDebug === undefined) delete process.env.ENFORCE_HOOK_DEBUG;
    else process.env.ENFORCE_HOOK_DEBUG = savedDebug;
    if (savedLogFile === undefined) delete process.env.HOOK_ERROR_LOG;
    else process.env.HOOK_ERROR_LOG = savedLogFile;
    delete require.cache[require.resolve('../hook-error-log')];
  });

  it('logHookError writes to the log file via fd', () => {
    const { logHookError } = require('../hook-error-log');
    logHookError(__filename, new Error('test error'));
    assert.ok(fs.existsSync(tmpFile), 'log file should exist');
    const content = fs.readFileSync(tmpFile, 'utf8');
    assert.ok(content.includes('test error'), 'log should contain the error message');
  });

  it('log line format includes timestamp, pid, filename, message', () => {
    const { logHookError } = require('../hook-error-log');
    logHookError(__filename, new Error('format check'));
    const content = fs.readFileSync(tmpFile, 'utf8');
    const line = content.trim();
    // Timestamp in ISO format: [2026-...]
    assert.match(line, /^\[\d{4}-\d{2}-\d{2}T/, 'should start with ISO timestamp');
    // PID
    assert.ok(line.includes(`pid=${process.pid}`), 'should contain pid');
    // Filename (basename)
    assert.ok(line.includes(path.basename(__filename)), 'should contain source filename');
    // Message
    assert.ok(line.includes('format check'), 'should contain the error message');
  });

  it('log lines are single-line (no embedded newlines)', () => {
    const { logHookError } = require('../hook-error-log');
    logHookError(__filename, new Error('line1\nline2\nline3'));
    const content = fs.readFileSync(tmpFile, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, 'should produce exactly one log line');
    assert.ok(!lines[0].includes('\n'), 'line should not contain embedded newlines');
  });

  it('lines are truncated when exceeding MAX_BYTES (3800 bytes)', () => {
    const { logHookError } = require('../hook-error-log');
    const longMessage = 'x'.repeat(5000);
    logHookError(__filename, new Error(longMessage));
    const content = fs.readFileSync(tmpFile, 'utf8');
    const line = content.trim();
    // Line including prefix must stay under 3800 bytes
    assert.ok(
      Buffer.byteLength(line + '\n', 'utf8') <= 3800,
      `line should be truncated (got ${Buffer.byteLength(line + '\n', 'utf8')} bytes)`
    );
    assert.ok(line.endsWith('...'), 'truncated line should end with ...');
  });

  it('ENFORCE_HOOK_DEBUG=1 writes to stderr instead of file', () => {
    process.env.ENFORCE_HOOK_DEBUG = '1';
    const { logHookError } = require('../hook-error-log');

    // Capture stderr output
    let stderrOutput = '';
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrOutput += chunk;
      return true;
    };
    try {
      logHookError(__filename, new Error('debug error'));
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.ok(stderrOutput.includes('debug error'), 'stderr should contain error message');
    // File should NOT exist or not contain the debug error (fd is never opened in debug mode)
    if (fs.existsSync(tmpFile)) {
      const content = fs.readFileSync(tmpFile, 'utf8');
      assert.ok(
        !content.includes('debug error'),
        'file should not contain the error in debug mode'
      );
    }
  });

  it('log file is created with 0o600 permissions via fd', () => {
    const { logHookError } = require('../hook-error-log');
    logHookError(__filename, new Error('perm check'));
    const stat = fs.statSync(tmpFile);
    // 0o600 = 0o100600 (file) => mode & 0o777 = 0o600
    const perms = stat.mode & 0o777;
    assert.strictEqual(perms, 0o600, `expected 0o600 permissions, got 0o${perms.toString(8)}`);
  });

  it('symlinks are removed before opening fd', () => {
    // Create a target file and a symlink pointing to it
    const targetFile = tmpFile + '.target';
    try {
      fs.writeFileSync(targetFile, 'target content', { mode: 0o600 });
      fs.symlinkSync(targetFile, tmpFile);

      assert.ok(fs.lstatSync(tmpFile).isSymbolicLink(), 'precondition: should be a symlink');

      const { logHookError } = require('../hook-error-log');
      logHookError(__filename, new Error('symlink test'));

      // The symlink should have been removed and replaced with a real file
      assert.ok(!fs.lstatSync(tmpFile).isSymbolicLink(), 'should no longer be a symlink');
      // Target file should be untouched
      assert.strictEqual(fs.readFileSync(targetFile, 'utf8'), 'target content');
    } finally {
      try {
        fs.unlinkSync(targetFile);
      } catch {}
    }
  });
});
