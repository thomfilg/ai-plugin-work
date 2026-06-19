// Singleton-guard integration (GH-622): launching `maestro-conduct.js --daemon`
// while a LIVE conductor holds the namespace lock must refuse (exit 3) instead
// of double-driving the agents. Drives the real CLI via spawnSync.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const CONDUCT = path.resolve(__dirname, '..', 'maestro-conduct.js');

function runDaemon(env, timeout = 10000) {
  // TICK_SEC large so that IF it ever got past the guard it wouldn't busy-loop;
  // the guard exits before any setInterval is armed. `timeout` reaps a daemon
  // that legitimately got past the guard (the FORCE case) so the test ends.
  return spawnSync('node', [CONDUCT, '--daemon'], {
    env: { ...process.env, TICK_SEC: '3600', ...env },
    encoding: 'utf8',
    timeout,
  });
}

test('second daemon refuses (exit 3) when a live conductor holds the lock', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-singleton-'));
  // Seed a live lock: pid 1 (init) is always alive, standing in for conductor #1.
  fs.writeFileSync(
    path.join(stateDir, 'conductor.lock'),
    JSON.stringify({ pid: 1, startedAt: 0, host: 'x', ns: '' })
  );
  const r = runDaemon({ STATE_DIR: stateDir, LOG_FILE: path.join(stateDir, 'log') });
  assert.equal(r.status, 3, `expected exit 3, got ${r.status}\nstderr:\n${r.stderr}`);
  assert.match(r.stderr, /CONDUCTOR-EXISTS/);
});

test('MAESTRO_FORCE=1 takes over the live lock (does not exit 3)', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-singleton-'));
  fs.writeFileSync(
    path.join(stateDir, 'conductor.lock'),
    JSON.stringify({ pid: 1, startedAt: 0, host: 'x', ns: '' })
  );
  // With FORCE the guard takes over and proceeds to setInterval → the process
  // would run forever, so `timeout` reaps it (CONDUCTOR-FORCED is logged
  // synchronously before the loop is armed, so stderr captures it). On the
  // timeout-kill the daemon's release-on-exit handler removes its own lock.
  const r = runDaemon(
    { STATE_DIR: stateDir, LOG_FILE: path.join(stateDir, 'log'), MAESTRO_FORCE: '1' },
    2500
  );
  assert.notEqual(r.status, 3, `must not refuse under FORCE; stderr:\n${r.stderr}`);
  assert.match(r.stderr, /CONDUCTOR-FORCED/);
});
