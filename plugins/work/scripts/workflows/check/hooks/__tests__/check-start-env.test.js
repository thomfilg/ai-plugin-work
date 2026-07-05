/**
 * check-start-env.js — zombie-leak regression tests
 * (issues/triage/unsorted/check-start-env-zombies-001.md)
 *
 * The hook used to keep pipe fds to detached children open and never called
 * process.exit(), leaving one resident node process per /check run
 * (17 zombies/day). These tests prove:
 *   1. The CLI prints its JSON and EXITS (spawnSync returning at all is the
 *      regression assertion — the old code hung here forever).
 *   2. startApp() detects the child's port from its log file (output is
 *      redirected to a log, not parent pipes) and resolves.
 *
 * All spawned commands are short-lived (`echo`/`true`) — no real servers.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'check-start-env.js');

// Fast timeouts so DB/app polling doesn't dominate test time
const FAST_ENV = {
  ...process.env,
  CHECK_ENV_DB_TIMEOUT_MS: '500',
  CHECK_ENV_APP_TIMEOUT_MS: '3000',
  CHECK_ENV_READY_WAIT_MS: '100',
  DEV_COMMAND: 'true', // benign no-op instead of `make dev-local`
};

describe('check-start-env.js — process exit behavior (zombie leak)', () => {
  it('CLI exits 0 with JSON output when there is nothing to start', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '[]'], {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...FAST_ENV, WEB_APPS: '[]' },
    });

    assert.equal(res.error, undefined, 'script must terminate (no spawnSync timeout)');
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr: ${res.stderr}`);
    const result = JSON.parse(res.stdout);
    assert.deepEqual(result.apps, {});
    assert.deepEqual(result.runningApps, {});
  });

  it('CLI exits even when an app start command produces no server', () => {
    const webApps = JSON.stringify([
      // `true` exits immediately without printing a Local: URL → timeout path
      { name: 'dead-app', defaultPort: 59983, startCommand: 'true' },
    ]);
    const res = spawnSync(process.execPath, [SCRIPT, JSON.stringify(['dead-app'])], {
      encoding: 'utf-8',
      timeout: 60000,
      env: { ...FAST_ENV, WEB_APPS: webApps },
    });

    assert.equal(res.error, undefined, 'script must terminate even on app-start timeout');
    assert.equal(res.status, 0);
    const result = JSON.parse(res.stdout);
    assert.equal(result.apps['dead-app'].started, false);
    assert.match(result.apps['dead-app'].error, /Timeout/);
  });
});

describe('check-start-env.js — startApp log-file port detection', () => {
  it('detects the port from the child log ("Local:" URL) without parent pipes', async () => {
    // require in-process only for the exported unit — module main() is guarded
    const { startApp } = require(SCRIPT);
    const appConfig = {
      name: 'echo-app',
      defaultPort: 59981,
      startCommand: 'echo Local: http://localhost:59981',
    };

    process.env.CHECK_ENV_APP_TIMEOUT_MS = '3000';
    const result = await startApp('echo-app', appConfig);

    assert.equal(result.started, true);
    assert.equal(result.port, 59981);
    assert.match(result.url, /:59981$/);
    assert.ok(result.logPath, 'result must expose the child log path for diagnostics');
  });
});
