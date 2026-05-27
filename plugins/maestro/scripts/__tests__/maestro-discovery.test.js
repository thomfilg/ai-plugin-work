// RED-phase tests for Task 3 (GH-429): widen discover_sessions() and fix
// ticket_id_for() suffix stripping in maestro-conduct.sh.
//
// Today discover_sessions() only matches `-work` and ticket_id_for() only
// strips `-work$`, so helper sessions (`-dev`, `-listen`) are invisible to the
// conductor and, when surfaced, keep their suffix in the derived ticket id.
// Task 3 widens both to the `work|dev|listen` suffix set:
//   - discover_sessions() returns ECHO-1-work, ECHO-2-listen, ECHO-3-dev
//   - ticket_id_for ECHO-5327-{work,dev,listen} -> ECHO-5327
//
// Like the resolve_prefix suite, these tests drive a thin throwaway entrypoint
// that sources maestro-conduct.sh under MAESTRO_SOURCE_ONLY=1 (suppressing the
// main poll loop), then exercises the function under test. The fake `tmux`
// stub (fixtures/tmux) scripts `list-sessions` via FAKE_TMUX_LIST_SESSIONS.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { runScript } = require('./helpers.js');

const CONDUCT_SH = path.resolve(__dirname, '..', 'maestro-conduct.sh');

/**
 * Build a thin entrypoint that sources the conductor in source-only mode and
 * then runs the supplied body (a few bash lines) against the in-scope helpers.
 * PREFIX/SESSION_PATTERN are forced so discovery is deterministic and does not
 * depend on the (provider-derived) default.
 * @param {string[]} body
 */
function makeEntrypoint(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-discovery-'));
  const script = path.join(dir, 'run-discovery.sh');
  fs.writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'set -u',
      'export MAESTRO_SOURCE_ONLY=1',
      `source "${CONDUCT_SH}"`,
      // Pin the prefix/pattern so discovery is independent of provider state.
      'PREFIX=ECHO',
      'SESSION_PATTERN="^${PREFIX}-[0-9]+-(work|dev|listen)$"',
      ...body,
    ].join('\n') + '\n'
  );
  return script;
}

test('discover_sessions widens to work, dev and listen helper sessions', () => {
  const script = makeEntrypoint(['discover_sessions']);
  const { stdout, status } = runScript(script, {
    env: {
      FAKE_TMUX_LIST_SESSIONS: ['ECHO-1-work', 'ECHO-2-listen', 'ECHO-3-dev'].join('\n'),
    },
  });

  assert.equal(status, 0, `entrypoint should exit 0\nstdout:\n${stdout}`);
  assert.match(stdout, /^ECHO-1-work$/m);
  assert.match(stdout, /^ECHO-2-listen$/m);
  assert.match(stdout, /^ECHO-3-dev$/m);
});

test('ticket_id_for strips the actual session suffix', () => {
  const script = makeEntrypoint([
    'echo "work=$(ticket_id_for ECHO-5327-work)"',
    'echo "dev=$(ticket_id_for ECHO-5327-dev)"',
    'echo "listen=$(ticket_id_for ECHO-5327-listen)"',
  ]);
  const { stdout, status } = runScript(script);

  assert.equal(status, 0, `entrypoint should exit 0\nstdout:\n${stdout}`);
  assert.match(stdout, /^work=ECHO-5327$/m);
  assert.match(stdout, /^dev=ECHO-5327$/m);
  assert.match(stdout, /^listen=ECHO-5327$/m);
});
