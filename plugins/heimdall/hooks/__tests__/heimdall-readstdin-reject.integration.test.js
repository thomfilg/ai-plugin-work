// Integration test for Task 3 (GH-690, R8): heimdall.js must read stdin through
// the vendored factory `readStdin({ onStreamError: 'reject' })` instead of the
// local `readStdinStrict` fork, WITHOUT weakening the fail-closed contract:
//
//   a stdin stream ERROR (payload possibly lost) → rejection propagates to
//   main().catch → NON-EMPTY stderr + exit 2 (block for safety).
//
// Discovered by plugins/work/scripts/run-tests.sh.
// Manual:
//   node --test plugins/heimdall/hooks/__tests__/heimdall-readstdin-reject.integration.test.js
//
// RED strategy (tasks.md red-mode: ablation): the vendored reject reader and the
// pre-existing `readStdinStrict` fork behave identically on a stream error, so a
// pure behavioral spawn assertion would already pass while the fork is in place.
// The load-bearing RED signal is therefore the *source contract*: this file
// asserts (1) heimdall.js no longer defines `readStdinStrict` and (2) it calls
// the factory `readStdin({ onStreamError: 'reject' })`. Both fail today (the fork
// is still present, the factory is not called) and pass once Task 3's GREEN edit
// lands — while the spawn assertions guard that the behavior is preserved across
// the swap in both directions (stream error blocks; valid payload allows).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hookScript = path.resolve(__dirname, '..', 'heimdall.js');
const hookSource = fs.readFileSync(hookScript, 'utf8');

// Pin TASKS_BASE / BASE_BRANCH in the child env (GH-690 R10): heimdall's config
// derivation walks git toplevel when these are unset, which flakes in CI. The
// stream-error path rejects before store discovery, but pin them anyway so the
// success-path spawn (which does reach discovery) stays deterministic.
const CHILD_ENV = {
  ...process.env,
  TASKS_BASE: process.env.TASKS_BASE || '/tmp/heimdall-readstdin-tasks',
  BASE_BRANCH: process.env.BASE_BRANCH || 'main',
};

// A `node --require <preload>` module that swaps process.stdin for a fake
// readable which schedules a stream 'error' before any 'end', forcing the real
// spawned hook down its stdin error branch. The 'error' fires on setImmediate so
// it lands AFTER the hook's reader has subscribed its 'error' listener (an
// un-subscribed 'error' would crash the process with exit 1 and mask the
// exit-2 contract under test). Written to a temp file because RED phase only
// permits *.test/*.spec files in the repo tree.
const PRELOAD_SRC = `'use strict';
const { Readable } = require('node:stream');
const fake = new Readable({ read() {} });
fake.isTTY = false;
Object.defineProperty(process, 'stdin', { configurable: true, get() { return fake; } });
setImmediate(() => { fake.emit('error', new Error('heimdall test: stdin stream boom')); });
`;

function withPreload(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-stdin-err-'));
  const preload = path.join(dir, 'erroring-stdin-preload.js');
  fs.writeFileSync(preload, PRELOAD_SRC);
  try {
    return fn(preload);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('heimdall.js reads stdin via the factory reject reader (GH-690 Task 3, R8)', () => {
  it('no longer defines a local readStdinStrict fork', () => {
    assert.ok(
      !/\breadStdinStrict\b/.test(hookSource),
      'heimdall.js must not define or reference readStdinStrict after migrating ' +
        'to the vendored factory reader'
    );
  });

  it("calls the vendored factory readStdin with onStreamError: 'reject'", () => {
    assert.match(
      hookSource,
      /readStdin\(\s*\{\s*onStreamError:\s*['"]reject['"]\s*\}\s*\)/,
      "heimdall.js must call readStdin({ onStreamError: 'reject' })"
    );
  });

  it('imports readStdin from the vendored hookEntrypoint', () => {
    assert.match(
      hookSource,
      /readStdin[^;]*require\([^)]*hookEntrypoint|hookEntrypoint[\s\S]*readStdin/,
      'heimdall.js must import readStdin from the vendored hookEntrypoint module'
    );
  });

  it('blocks (exit 2, non-empty stderr) when stdin errors before end', () => {
    withPreload((preload) => {
      const res = spawnSync(process.execPath, ['--require', preload, hookScript], {
        cwd: os.tmpdir(),
        env: CHILD_ENV,
        encoding: 'utf8',
      });
      assert.equal(
        res.status,
        2,
        `expected exit 2 on stdin stream error, got ${res.status}; stderr: ${res.stderr}`
      );
      assert.ok(
        res.stderr && res.stderr.trim().length > 0,
        `fail-closed contract requires non-empty stderr on exit 2; stderr: ${JSON.stringify(res.stderr)}`
      );
    });
  });

  it('allows (exit 0) a valid payload when no locks are configured', () => {
    const res = spawnSync(process.execPath, [hookScript], {
      cwd: os.tmpdir(),
      env: CHILD_ENV,
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }),
      encoding: 'utf8',
    });
    assert.equal(
      res.status,
      0,
      `expected exit 0 on a valid payload with no locks, got ${res.status}; stderr: ${res.stderr}`
    );
  });
});
