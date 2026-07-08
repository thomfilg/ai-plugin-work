// Tests for resolve_prefix() in lib/resolve-prefix.sh (sourced by
// maestro-bootstrap.sh).
//
// resolve_prefix() must derive the ticket prefix from the ticket provider
// (via `node -e` against ticket-provider.js) and fail open to `GH`:
//   - provider projectKey "ECHO"  -> PREFIX=ECHO
//   - github (projectKey: '')     -> PREFIX=GH
//   - unconfigured (empty / null) -> PREFIX=GH
//   - node/module unavailable     -> exit 0, PREFIX=GH (fail-open, no hard error)
//   - malformed prefix            -> rejected by ^[A-Z][A-Z0-9]*$, PREFIX=GH
//
// These tests source the lib directly, call resolve_prefix, derive the same
// SESSION_PATTERN the bootstrap script builds from it, and assert both. The
// fake `node` stub (fixtures/node) stands in for the real provider resolution
// and is selected via FAKE_NODE_MODE.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { runScript } = require('./helpers.js');

const RESOLVE_PREFIX_SH = path.resolve(__dirname, '..', 'lib', 'resolve-prefix.sh');

/**
 * Build a thin entrypoint that sources lib/resolve-prefix.sh, runs
 * resolve_prefix, derives the same SESSION_PATTERN the bootstrap script uses,
 * and prints PREFIX + SESSION_PATTERN on stable, greppable lines.
 */
function makeEntrypoint() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-prefix-'));
  const script = path.join(dir, 'run-resolve-prefix.sh');
  fs.writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'set -u',
      `source "${RESOLVE_PREFIX_SH}"`,
      'resolve_prefix',
      'SESSION_PATTERN="${SESSION_PATTERN:-^${PREFIX}-[0-9]+-(work|dev|listen)$}"',
      'echo "PREFIX=${PREFIX:-}"',
      'echo "SESSION_PATTERN=${SESSION_PATTERN}"',
    ].join('\n') + '\n'
  );
  return script;
}

test('Prefix derives from provider projectKey when configured', () => {
  const script = makeEntrypoint();
  const { stdout, status } = runScript(script, {
    env: {
      FAKE_NODE_MODE: 'projectKey',
      FAKE_NODE_PROJECT_KEY: 'ECHO',
      // Ensure no inherited SESSION_PATTERN masks the derivation.
      SESSION_PATTERN: '',
    },
  });

  assert.equal(status, 0, `entrypoint should exit 0\nstdout:\n${stdout}`);
  assert.match(stdout, /^PREFIX=ECHO$/m);
  assert.match(stdout, /^SESSION_PATTERN=\^ECHO-\[0-9\]\+-\(work\|dev\|listen\)\$$/m);
});

test('Prefix falls back to GH when provider is github', () => {
  const script = makeEntrypoint();
  // github provider reports an empty projectKey.
  const { stdout, status } = runScript(script, {
    env: {
      FAKE_NODE_MODE: 'projectKey',
      FAKE_NODE_PROJECT_KEY: '',
      SESSION_PATTERN: '',
    },
  });

  assert.equal(status, 0, `entrypoint should exit 0\nstdout:\n${stdout}`);
  assert.match(stdout, /^PREFIX=GH$/m);
  assert.match(stdout, /^SESSION_PATTERN=\^GH-\[0-9\]\+-\(work\|dev\|listen\)\$$/m);
  // Never emit an empty-prefix pattern.
  assert.doesNotMatch(stdout, /SESSION_PATTERN=\^-\[0-9\]\+-\(work\|dev\|listen\)\$/);
});

test('Prefix falls back to GH when provider is unconfigured', () => {
  const script = makeEntrypoint();
  // Unconfigured / null provider: stub prints nothing, exits 0.
  const { stdout, status } = runScript(script, {
    env: {
      FAKE_NODE_MODE: 'projectKey',
      FAKE_NODE_PROJECT_KEY: '',
      SESSION_PATTERN: '',
    },
  });

  assert.equal(status, 0, `entrypoint should exit 0\nstdout:\n${stdout}`);
  assert.match(stdout, /^PREFIX=GH$/m);
  assert.match(stdout, /^SESSION_PATTERN=\^GH-\[0-9\]\+-\(work\|dev\|listen\)\$$/m);
  assert.doesNotMatch(stdout, /SESSION_PATTERN=\^-\[0-9\]\+-\(work\|dev\|listen\)\$/);
});

test('Prefix fails open to GH when node or provider module is unavailable', () => {
  const script = makeEntrypoint();
  // node/module unavailable: stub exits non-zero. Must not hard-error the
  // entrypoint and must default to GH.
  const { stdout, status } = runScript(script, {
    env: {
      FAKE_NODE_MODE: 'fail',
      SESSION_PATTERN: '',
    },
  });

  assert.equal(status, 0, `fail-open: entrypoint must still exit 0\nstdout:\n${stdout}`);
  assert.match(stdout, /^PREFIX=GH$/m);
  assert.match(stdout, /^SESSION_PATTERN=\^GH-\[0-9\]\+-\(work\|dev\|listen\)\$$/m);
});

test('a malformed provider prefix is rejected and falls back to GH', () => {
  const script = makeEntrypoint();
  // Provider returns a value that fails ^[A-Z][A-Z0-9]*$ validation.
  const { stdout, status } = runScript(script, {
    env: {
      FAKE_NODE_MODE: 'garbage',
      FAKE_NODE_GARBAGE: 'ECHO; rm -rf /',
      SESSION_PATTERN: '',
    },
  });

  assert.equal(status, 0, `entrypoint should exit 0\nstdout:\n${stdout}`);
  assert.match(stdout, /^PREFIX=GH$/m);
  assert.match(stdout, /^SESSION_PATTERN=\^GH-\[0-9\]\+-\(work\|dev\|listen\)\$$/m);
  // The raw malformed value must never leak into the prefix/pattern.
  assert.doesNotMatch(stdout, /rm -rf/);
});
