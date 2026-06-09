'use strict';

// Unit tests for gitHunkChangedSince() — pure unit, execFileSync stubbed.
// Covers:
//   (1) changed-hunk → true  (git log -L emits output)
//   (2) no-change-since-timestamp → false (git log -L empty)
//   (3) invalid sinceIso → throws

const test = require('node:test');
const assert = require('node:assert/strict');

const MODULE_PATH = require.resolve('../git-hunk-changed.js');

function withStubbedExecFileSync(stub, fn) {
  const childProcess = require('node:child_process');
  const original = childProcess.execFileSync;
  childProcess.execFileSync = stub;
  // Force re-require so the module picks up the stubbed binding if it
  // captured a local reference at load time.
  delete require.cache[MODULE_PATH];
  try {
    return fn(require(MODULE_PATH));
  } finally {
    childProcess.execFileSync = original;
    delete require.cache[MODULE_PATH];
  }
}

test('gitHunkChangedSince returns true when git log -L emits output (hunk changed)', () => {
  const calls = [];
  const stub = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return Buffer.from(
      'commit abc123\nAuthor: x\nDate: ...\n\ndiff --git a/foo.js b/foo.js\n@@ -10,1 +10,1 @@\n-old\n+new\n'
    );
  };
  withStubbedExecFileSync(stub, (mod) => {
    const result = mod.gitHunkChangedSince('src/foo.js', 10, '2026-01-01T00:00:00Z');
    assert.equal(result, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'git');
    assert.ok(calls[0].args.includes('--since'), 'git args should include --since');
    assert.ok(
      calls[0].args.includes('2026-01-01T00:00:00Z'),
      'git args should include the sinceIso value'
    );
    // -L should be passed as a flag with a line,line:file argument
    const lFlagIdx = calls[0].args.indexOf('-L');
    assert.ok(lFlagIdx >= 0, '-L flag should be present');
    const lArg = calls[0].args[lFlagIdx + 1];
    assert.ok(
      /^10,10:src\/foo\.js$/.test(lArg),
      `expected -L arg to be '10,10:src/foo.js', got '${lArg}'`
    );
  });
});

test('gitHunkChangedSince returns false when git log -L output is empty (no change)', () => {
  const stub = () => Buffer.from('');
  withStubbedExecFileSync(stub, (mod) => {
    const result = mod.gitHunkChangedSince('src/foo.js', 42, '2026-01-01T00:00:00Z');
    assert.equal(result, false);
  });
});

test('gitHunkChangedSince passes timeout=5000 and forwards ctx.cwd to execFileSync', () => {
  const calls = [];
  const stub = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return Buffer.from('');
  };
  withStubbedExecFileSync(stub, (mod) => {
    mod.gitHunkChangedSince('src/foo.js', 10, '2026-01-01T00:00:00Z', { cwd: '/tmp/wt' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.timeout, 5000, 'timeout option must be 5000ms');
    assert.equal(calls[0].opts.cwd, '/tmp/wt', 'ctx.cwd must be forwarded');
  });
});

test('gitHunkChangedSince omits cwd when ctx has no cwd', () => {
  const calls = [];
  const stub = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return Buffer.from('');
  };
  withStubbedExecFileSync(stub, (mod) => {
    mod.gitHunkChangedSince('src/foo.js', 10, '2026-01-01T00:00:00Z');
    assert.equal(calls[0].opts.cwd, undefined, 'cwd should be unset to inherit process.cwd()');
    assert.equal(calls[0].opts.timeout, 5000);
  });
});

test('gitHunkChangedSince throws on invalid sinceIso', () => {
  const stub = () => {
    throw new Error('execFileSync should not be called on invalid sinceIso');
  };
  withStubbedExecFileSync(stub, (mod) => {
    assert.throws(
      () => mod.gitHunkChangedSince('src/foo.js', 10, 'not-an-iso-date'),
      /sinceIso|ISO|invalid/i
    );
    assert.throws(() => mod.gitHunkChangedSince('src/foo.js', 10, ''), /sinceIso|ISO|invalid/i);
  });
});
