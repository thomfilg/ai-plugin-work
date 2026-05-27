// Smoke test for the maestro test harness (Task 1, GH-429).
//
// Proves the shared helper can:
//   1. put the fixture stub dir first on PATH,
//   2. run a bash script via spawnSync and capture stdout/stderr/status,
//   3. observe `tmux new-session` invocations through the capture log
//      exposed as `newSessionCalls`.
//
// It drives a tiny throwaway script (not the real maestro scripts) so the
// smoke test stays self-contained and does not depend on Tasks 2-6.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { runScript } = require('./helpers.js');

test('runScript captures stdout from a bash script', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-smoke-'));
  const script = path.join(dir, 'echo.sh');
  fs.writeFileSync(script, '#!/usr/bin/env bash\necho "hello-from-script"\n');

  const { stdout, status } = runScript(script, {});

  assert.equal(status, 0);
  assert.match(stdout, /hello-from-script/);
});

test('runScript puts the fake tmux stub first on PATH and records new-session calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-smoke-'));
  // A throwaway script that calls `tmux new-session` twice. The fake tmux
  // stub (fixtures/tmux) must be resolved from PATH, not the real tmux, and
  // must log each new-session invocation for the helper to surface.
  const script = path.join(dir, 'spawn.sh');
  fs.writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'set -u',
      'tmux new-session -d -s ECHO-1-work -c /tmp "claude"',
      'tmux new-session -d -s ECHO-2-work -c /tmp "claude"',
      'echo done',
    ].join('\n') + '\n'
  );

  const { stdout, status, newSessionCalls } = runScript(script, {});

  assert.equal(status, 0);
  assert.match(stdout, /done/);
  assert.ok(Array.isArray(newSessionCalls), 'newSessionCalls should be an array');
  assert.equal(newSessionCalls.length, 2);
  assert.ok(
    newSessionCalls.some((c) => c.includes('ECHO-1-work')),
    'first new-session call should be captured'
  );
  assert.ok(
    newSessionCalls.some((c) => c.includes('ECHO-2-work')),
    'second new-session call should be captured'
  );
});
