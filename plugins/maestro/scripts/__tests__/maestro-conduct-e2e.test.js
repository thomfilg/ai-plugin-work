// RED-phase test for Task 6 (GH-429): end-to-end conductor poll discovers ECHO
// sessions with provider config.
//
// This test exercises the FULL poll loop wiring across the three behaviours
// settled in Tasks 2-4, all in one bounded run of the real conductor:
//
//   - resolve_prefix() (Task 2) shells out to the (faked) ticket provider and
//     derives PREFIX=ECHO — so we deliberately DO NOT override
//     DISCOVERY_PATTERN/SESSION_PATTERN here; the resolver must drive them.
//   - discover_sessions() (Task 3) must then surface BOTH the `-work` session
//     and the `-dev` helper (widened discovery).
//   - the -work$ auto-restart guard (Task 4) must keep the `-dev` helper
//     non-restart-eligible (zero relaunch calls for it).
//
// The conductor body is an infinite `while true` poll loop. For an e2e run we
// need a single bounded iteration that COMPLETES with a non-error exit inside
// the test timeout — not a run that only ends because the spawn timeout SIGTERMs
// it (which yields a null/non-zero status). Task 6's GREEN deliverable is a
// `MAESTRO_MAX_ITERATIONS=1` test hook bounding the loop; this RED test asserts
// that hook produces a clean exit-0 single iteration.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { runScript } = require('./helpers.js');

const CONDUCT_SH = path.resolve(__dirname, '..', 'maestro-conduct.sh');

test('conductor discovers ECHO sessions end to end with provider config', () => {
  // Real worktree dir for the -work session so auto-restart would have a valid
  // relaunch target if it were eligible — this isolates discovery + the -work$
  // guard as the only things under test (not a missing-worktree skip).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-'));
  const stateDir = path.join(root, 'state');
  const worktreesBase = path.join(root, 'worktrees');
  const repoName = 'claude-plugin-work';
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(worktreesBase, `${repoName}-ECHO-5327`), {
    recursive: true,
  });

  const workSession = 'ECHO-5327-work';
  const devSession = 'ECHO-5348-dev';

  const { stdout, status, newSessionCalls } = runScript(CONDUCT_SH, {
    timeout: 8000,
    env: {
      // Provider config → projectKey ECHO, driving resolve_prefix → PREFIX=ECHO
      // (and therefore the discovery + session patterns).
      FAKE_NODE_MODE: 'projectKey',
      FAKE_NODE_PROJECT_KEY: 'ECHO',
      // Do NOT set DISCOVERY_PATTERN / SESSION_PATTERN — the resolver must
      // derive them from the provider-supplied prefix.
      STATE_DIR: stateDir,
      WORKTREES_BASE: worktreesBase,
      REPO_NAME: repoName,
      SKILL_NAME: 'work',
      CLAUDE_BIN: 'true',
      // Both sessions in one scripted list-sessions response (newline-joined).
      FAKE_TMUX_LIST_SESSIONS: `${workSession}\n${devSession}`,
      FAKE_TMUX_CAPTURE_PANE: 'idle pane: no spinner here',
      // Bound the poll loop to exactly one iteration so the run completes with a
      // clean exit instead of relying on a spawn-timeout kill.
      MAESTRO_MAX_ITERATIONS: '1',
    },
  });

  // The bounded single iteration must complete with a non-error exit inside the
  // test timeout (status 0, not a SIGTERM-induced null/non-zero).
  assert.equal(status, 0, `bounded e2e poll iteration should exit 0\nstdout:\n${stdout}`);

  // The -work session is discovered and polled (it appears in conductor output).
  assert.match(
    stdout,
    new RegExp(workSession),
    `${workSession} should be discovered and polled\nstdout:\n${stdout}`
  );

  // The -dev helper is discovered too (widened discovery) ...
  assert.match(
    stdout,
    new RegExp(devSession),
    `${devSession} helper should be discovered\nstdout:\n${stdout}`
  );

  // ... but is reported NOT auto-restart-eligible, and triggers zero relaunches.
  const devRelaunch = newSessionCalls.filter((c) => c.includes(devSession));
  assert.equal(
    devRelaunch.length,
    0,
    `${devSession} helper must not be auto-restart-eligible\nstdout:\n${stdout}\nnewSessionCalls:\n${newSessionCalls.join('\n')}`
  );
});
