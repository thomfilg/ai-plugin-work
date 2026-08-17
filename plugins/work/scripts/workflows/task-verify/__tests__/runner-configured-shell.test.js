'use strict';

/**
 * runner-configured-shell.test.js
 *
 * The repo-configured test command must run under the SAME shell as the rest
 * of the TDD pipeline. `tdd-phase-state/io.js` and `task-next.js` runTest()
 * both use `spawnSync('bash', ['-lc', cmd])`, and its comment spells out why:
 * /bin/sh is dash on Debian/Ubuntu, and the strict-mode wrappers these
 * templates carry (`set -euo pipefail; …`, GH-392 §P0#3) die on dash with
 * "set: Illegal option -o pipefail".
 *
 * Running the repo's own command under a shell that cannot execute it would
 * manufacture the exact false "tests do not pass on head" contradiction that
 * configuredCommand() exists to remove — so this is not a style preference.
 *
 * Uses node:test + node:assert/strict.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { configuredCommand } = require('../collect/runner');

const STRICT = 'set -euo pipefail; pnpm test:unit';

let repo;
let saved;

beforeEach(() => {
  saved = { unit: process.env.TEST_UNIT_COMMAND, all: process.env.TEST_COMMAND };
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-shell-'));
  // repoCanRunTemplate() only accepts a template whose script the repo declares.
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { 'test:unit': 'true' } })
  );
});

afterEach(() => {
  for (const [k, v] of [
    ['TEST_UNIT_COMMAND', saved.unit],
    ['TEST_COMMAND', saved.all],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('configuredCommand shell parity (GH-755)', () => {
  it('runs the configured template under bash -lc, not sh -c', () => {
    process.env.TEST_UNIT_COMMAND = STRICT;
    const run = configuredCommand(['a.test.ts'], 'vitest', repo);

    assert.ok(run, 'a declared script must produce a configured run');
    assert.equal(run.cmd, 'bash', '/bin/sh is dash — it cannot run these templates');
    assert.equal(run.args[0], '-lc');
    assert.ok(run.args[1].startsWith('set -euo pipefail;'), 'template passed through verbatim');
  });

  it('resolves bash through PATH rather than pinning /bin/bash', () => {
    // Parity with io.js and task-next.js: an absolute pin splits the pipeline
    // on hosts that keep bash elsewhere (NixOS, homebrew).
    process.env.TEST_UNIT_COMMAND = STRICT;
    assert.equal(configuredCommand(['a.test.ts'], 'jest', repo).cmd, 'bash');
  });

  it('the chosen shell can actually execute a strict-mode template', () => {
    process.env.TEST_UNIT_COMMAND = 'set -euo pipefail; echo ran';
    const run = configuredCommand(['a.test.ts'], 'node-test', repo);
    // No REPORTER_FLAG lookup issue: node-test appends a TAP flag, so strip it
    // and prove the shell itself accepts the wrapper.
    const spawned = spawnSync(run.cmd, [run.args[0], 'set -euo pipefail; echo ran'], {
      encoding: 'utf8',
    });
    assert.equal(spawned.status, 0, `strict-mode wrapper must run: ${spawned.stderr}`);
    assert.match(spawned.stdout, /ran/);

    // The shell the PR originally used fails this outright wherever /bin/sh is
    // dash — asserted only there, so the test stays meaningful on bash-as-sh
    // platforms instead of silently passing.
    const viaSh = spawnSync('sh', ['-c', 'set -euo pipefail; echo ran'], { encoding: 'utf8' });
    if (viaSh.status !== 0) {
      assert.match(viaSh.stderr, /pipefail/, 'dash rejects the wrapper — bash is required');
    }
  });

  it('still returns null when nothing is configured', () => {
    delete process.env.TEST_UNIT_COMMAND;
    delete process.env.TEST_COMMAND;
    assert.equal(configuredCommand(['a.test.ts'], 'vitest', repo), null);
  });

  it('still falls back when the repo does not declare the script', () => {
    process.env.TEST_UNIT_COMMAND = 'pnpm test:not-declared';
    assert.equal(configuredCommand(['a.test.ts'], 'vitest', repo), null);
  });
});
