// RED-phase tests for Task 4 (GH-429): restrict auto-restart in
// maestro-conduct.sh to `-work` sessions only.
//
// discover_sessions() (Task 3) surfaces `-work`, `-dev` and `-listen` helper
// sessions informationally, but only `-work` sessions are auto-restart
// eligible. Today the poll loop relaunches ANY silent discovered session via
// `tmux kill-session` + `tmux new-session`, which would wrongly resurrect a
// `-listen`/`-dev` helper as a `/work <tid>` session. Task 4 adds a `-work$`
// guard so non-work helpers are skipped with an informational line and never
// relaunched.
//
// These tests drive ONE real poll iteration of the conductor: the script runs
// unbounded (`while true`), so we configure a large POLL_INTERVAL_SEC and use a
// spawn timeout — the body executes exactly once, then the script blocks in
// `sleep` until the timeout terminates it. We pre-seed the per-session `.meta`
// state with a stale timestamp so the session reads as silent past
// SILENCE_LIMIT_SEC on the first (and only) iteration, and point WORKTREES_BASE
// at a real temp dir so the worktree-present branch is taken.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { runScript } = require('./helpers.js');

const CONDUCT_SH = path.resolve(__dirname, '..', 'maestro-conduct.sh');

/**
 * Build the per-session state + worktree scaffolding for one poll iteration and
 * return the env needed to drive the real conductor once.
 *
 * @param {Object} opts
 * @param {string} opts.session   tmux session name (e.g. ECHO-2-listen).
 * @param {string} opts.ticketId  ticket id the session strips to (e.g. ECHO-2).
 * @returns {{ env: Record<string,string> }}
 */
function setupSilentSession({ session, ticketId }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-autorestart-'));
  const stateDir = path.join(root, 'state');
  const worktreesBase = path.join(root, 'worktrees');
  const repoName = 'claude-plugin-work';
  fs.mkdirSync(stateDir, { recursive: true });
  // Worktree must EXIST so auto-restart takes the relaunch branch (not the
  // "worktree not found" skip) — this isolates the -work$ guard as the only
  // thing preventing relaunch of a helper session.
  fs.mkdirSync(path.join(worktreesBase, `${repoName}-${ticketId}`), {
    recursive: true,
  });

  // Stale state: ts_prev far in the past so silence >> SILENCE_LIMIT_SEC, and a
  // hash/token pair that will match the captured pane so the session reads as
  // inactive (no hash move, no token change, no spinner). The pane content is
  // an empty string captured by the fake tmux below; its md5 is computed by the
  // script, so we leave hash_prev empty-but-present by writing a known value —
  // instead we make the pane match by giving a stable pane and matching toks.
  const metaPath = path.join(stateDir, `${session}.last.meta`);
  // hash line is intentionally a non-matching placeholder is unsafe (first-sight
  // logic treats empty hash_prev as active). We need hash_prev == hash_now to be
  // inactive; the script computes hash_now from the pane. We therefore precompute
  // below after we know the pane.
  return { root, stateDir, worktreesBase, repoName, metaPath };
}

/**
 * Drive exactly one poll iteration of the real conductor against a silent
 * session, returning the runScript result.
 *
 * @param {Object} opts
 * @param {string} opts.session
 * @param {string} opts.ticketId
 */
function runOnePoll({ session, ticketId }) {
  const { stateDir, worktreesBase, repoName, metaPath } = setupSilentSession({
    session,
    ticketId,
  });

  // The pane the fake tmux returns. Static, no live spinner, no tokens — so the
  // only thing that could mark it active is a hash move or first-sighting.
  const pane = 'idle pane: no spinner here';
  // Compute md5 the same way the script does: `echo "$pane" | md5sum`. `echo`
  // appends a trailing newline, matching the script's `echo "$pane" | md5sum`.
  const crypto = require('node:crypto');
  const hashNow = crypto.createHash('md5').update(`${pane}\n`).digest('hex');

  // Pre-seed stale meta: same hash (no move), same tokens (0), old timestamp.
  fs.writeFileSync(metaPath, `${hashNow}\n0\n1\n`);

  return runScript(CONDUCT_SH, {
    timeout: 8000,
    env: {
      STATE_DIR: stateDir,
      WORKTREES_BASE: worktreesBase,
      REPO_NAME: repoName,
      SILENCE_LIMIT_SEC: '1',
      POLL_INTERVAL_SEC: '3600', // sleep long after the single iteration
      // The conductor calls resolve_prefix() at source time, which would reset
      // PREFIX to the provider-derived value (GH, since the provider fails in
      // the harness). Override SESSION_PATTERN directly so discovery surfaces
      // the ECHO-* session deterministically regardless of resolve_prefix.
      SESSION_PATTERN: '^ECHO-[0-9]+-(work|dev|listen)$',
      SKILL_NAME: 'work',
      CLAUDE_BIN: 'true',
      FAKE_TMUX_LIST_SESSIONS: session,
      FAKE_TMUX_CAPTURE_PANE: pane,
    },
  });
}

test('discovery surfaces helper sessions but only -work is restart-eligible', () => {
  // A silent -listen helper is discovered, but must NOT be relaunched.
  const { stdout, newSessionCalls, killSessionCalls } = runOnePoll({
    session: 'ECHO-2-listen',
    ticketId: 'ECHO-2',
  });

  const listenRelaunch = newSessionCalls.filter((c) => c.includes('ECHO-2-listen'));
  assert.equal(
    listenRelaunch.length,
    0,
    `non-work helper session must not be relaunched\nstdout:\n${stdout}\nnewSessionCalls:\n${newSessionCalls.join('\n')}`
  );
  assert.equal(
    killSessionCalls.filter((c) => c.includes('ECHO-2-listen')).length,
    0,
    'non-work helper session must not be killed for relaunch'
  );
  // The conductor must surface the helper as skipped / informational, not silently.
  assert.match(
    stdout,
    /ECHO-2-listen/,
    'conductor should report the discovered non-work helper session'
  );
});

test('auto-restart never relaunches a non-work helper session', () => {
  // A silent -dev helper past the silence limit must trigger zero relaunches.
  const { stdout, newSessionCalls } = runOnePoll({
    session: 'ECHO-3-dev',
    ticketId: 'ECHO-3',
  });

  assert.equal(
    newSessionCalls.length,
    0,
    `no new-session relaunch should be issued for a -dev helper\nstdout:\n${stdout}\nnewSessionCalls:\n${newSessionCalls.join('\n')}`
  );
});

test('silent -work session with present worktree still relaunches exactly once', () => {
  // Regression guard: the -work$ restriction must not break legitimate
  // auto-restart of a real /work session.
  const { stdout, newSessionCalls } = runOnePoll({
    session: 'ECHO-1-work',
    ticketId: 'ECHO-1',
  });

  const workRelaunch = newSessionCalls.filter((c) => c.includes('ECHO-1-work'));
  assert.equal(
    workRelaunch.length,
    1,
    `a silent -work session with present worktree should relaunch exactly once\nstdout:\n${stdout}\nnewSessionCalls:\n${newSessionCalls.join('\n')}`
  );
});
