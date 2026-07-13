// RED-phase tests for Task 5 (GH-429): provider-aware prefix in
// maestro-bootstrap.sh — the bare-number ticket normalization (currently the
// literal `GH-$TICKET` at :94) and the active-sessions listing grep (currently
// the literal `^GH-[0-9]+-work:` at :134) must both derive their prefix from
// the ticket provider via a fail-open `resolve_prefix()`, mirroring Task 2 in
// maestro-conduct.sh:
//   - no provider env (github / unconfigured) -> PREFIX=GH, byte-for-byte
//     today's output (listing shows only GH-<N>-work, bare 429 -> GH-429).
//   - provider projectKey "ECHO"               -> PREFIX=ECHO (lists ECHO-<N>-work,
//     bare 429 -> ECHO-429).
//
// The bootstrap script does real filesystem work (REPO_DIR/.git check, worktree
// dir existence) and shells out to tmux/git/node — all faked via the Task 1
// fixtures. To keep the run hermetic we drive bootstrap through a tiny wrapper
// that `cd`s into the throwaway WORKTREES_BASE first: this guarantees the
// script's `$PWD/../.envrc` / `$PWD/.envrc` lookup finds nothing (so the real
// repo's .envrc never overrides our scripted env), and stands up a fake
// `<REPO_NAME>/.git` so the repo guard passes. The fake node stub selects the
// provider mode; assertions are on stdout.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { runScript } = require('./helpers.js');

const BOOTSTRAP_SH = path.resolve(__dirname, '..', 'maestro-bootstrap.sh');
const REPO_NAME = 'claude-plugin-work';

/**
 * Create a throwaway WORKTREES_BASE with a fake `<REPO_NAME>/.git` dir so the
 * bootstrap repo guard (`[ ! -d "$REPO_DIR/.git" ]`) passes, and a wrapper
 * script that `cd`s into that dir (which has no `.envrc` above it) before
 * exec'ing the real bootstrap. Returns the wrapper path. Worktree dirs
 * intentionally do NOT exist so the (faked) `git worktree add` path runs.
 */
function makeWrapper() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-wt-'));
  fs.mkdirSync(path.join(base, REPO_NAME, '.git'), { recursive: true });
  // A sandbox cwd with no .envrc in it or above it (the temp dir's parents are
  // OS temp dirs) so bootstrap's `$PWD/../.envrc` lookup is a no-op.
  const sandboxCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cwd-'));
  const wrapper = path.join(base, 'run-bootstrap.sh');
  fs.writeFileSync(
    wrapper,
    [
      '#!/usr/bin/env bash',
      `cd "${sandboxCwd}" || exit 1`,
      `exec bash "${BOOTSTRAP_SH}" "$@"`,
    ].join('\n') + '\n'
  );
  return { wrapper, base };
}

function baseEnv(base, extra = {}) {
  return {
    WORKTREES_BASE: base,
    REPO_NAME,
    // No real session exists, so the script launches a (faked) new-session and
    // then prints the active-sessions listing we assert on.
    FAKE_TMUX_HAS_SESSION: '1',
    ...extra,
  };
}

const RUN_OPTS = { timeout: 30000 };

test('GitHub default behavior unchanged with no provider env', () => {
  const { wrapper, base } = makeWrapper();
  const { stdout, status } = runScript(wrapper, {
    ...RUN_OPTS,
    args: ['GH-397', 'GH-414'],
    env: baseEnv(base, {
      // No provider env: model github / unconfigured -> empty projectKey.
      FAKE_NODE_MODE: 'projectKey',
      FAKE_NODE_PROJECT_KEY: '',
      // tmux list-sessions returns the two GH sessions plus an unrelated one;
      // the listing must show exactly the two GH-<N>-work lines.
      FAKE_TMUX_LIST_SESSIONS:
        'GH-397-work: 1 windows\nGH-414-work: 1 windows\nsomething-else: 1 windows',
    }),
  });

  assert.equal(status, 0, `bootstrap should exit 0\nstdout:\n${stdout}`);
  // Byte-for-byte GH default: exactly the two GH-<N>-work lines, unrelated
  // session filtered out.
  assert.match(stdout, /^GH-397-work: 1 windows$/m);
  assert.match(stdout, /^GH-414-work: 1 windows$/m);
  assert.doesNotMatch(stdout, /something-else/);
});

test('provider projectKey ECHO lists ECHO-<N>-work sessions', () => {
  const { wrapper, base } = makeWrapper();
  const { stdout, status } = runScript(wrapper, {
    ...RUN_OPTS,
    args: ['ECHO-5327'],
    env: baseEnv(base, {
      FAKE_NODE_MODE: 'projectKey',
      FAKE_NODE_PROJECT_KEY: 'ECHO',
      FAKE_TMUX_LIST_SESSIONS: 'ECHO-5327-work: 1 windows\nGH-397-work: 1 windows',
    }),
  });

  assert.equal(status, 0, `bootstrap should exit 0\nstdout:\n${stdout}`);
  // With PREFIX=ECHO the listing surfaces the ECHO session and filters GH.
  assert.match(stdout, /^ECHO-5327-work: 1 windows$/m);
  assert.doesNotMatch(stdout, /^GH-397-work:/m);
});

test('bare number normalizes to GH-<N> with no provider env', () => {
  const { wrapper, base } = makeWrapper();
  const { stdout, status } = runScript(wrapper, {
    ...RUN_OPTS,
    args: ['429'],
    env: baseEnv(base, {
      FAKE_NODE_MODE: 'projectKey',
      FAKE_NODE_PROJECT_KEY: '',
      FAKE_TMUX_LIST_SESSIONS: 'GH-429-work: 1 windows',
    }),
  });

  assert.equal(status, 0, `bootstrap should exit 0\nstdout:\n${stdout}`);
  // Bare 429 with no provider normalizes to GH-429 (today's behavior).
  assert.match(stdout, /\bGH-429\b/);
  assert.doesNotMatch(stdout, /\bECHO-429\b/);
});

test('bare number normalizes to ECHO-<N> when provider is ECHO', () => {
  const { wrapper, base } = makeWrapper();
  const { stdout, status } = runScript(wrapper, {
    ...RUN_OPTS,
    args: ['429'],
    env: baseEnv(base, {
      FAKE_NODE_MODE: 'projectKey',
      FAKE_NODE_PROJECT_KEY: 'ECHO',
      FAKE_TMUX_LIST_SESSIONS: 'ECHO-429-work: 1 windows',
    }),
  });

  assert.equal(status, 0, `bootstrap should exit 0\nstdout:\n${stdout}`);
  // Bare 429 with provider ECHO normalizes to ECHO-429.
  assert.match(stdout, /\bECHO-429\b/);
  assert.doesNotMatch(stdout, /\bGH-429\b/);
});
