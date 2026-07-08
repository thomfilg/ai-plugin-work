// GH-680 Task 1 — Wake-channel routing + heartbeat cadence/marker.
//
// The maestro daemon has a single "wake the conductor model" channel:
// process.stderr.write inside alerts.log(). Benign HEARTBEATs currently ride
// that same channel, so an idle fleet burns model wakes on non-actionable
// summaries. These tests pin the new routing contract:
//   (a) heartbeat.maybeEmitHeartbeat writes a `_heartbeat.json` marker under
//       STATE_DIR and appends to the logfile, but writes NOTHING to stderr;
//       a state-change beat still emits immediately.
//   (b) alerts.alert({kind:'pr-broken'}) still writes stderr under the default
//       allowlist; wakesConductor honors a restricted CONDUCT_WAKE_EVENTS and
//       the `all` escape hatch.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const LIB = (name) => path.resolve(__dirname, '..', 'lib', 'maestro-conduct', name);

// Reload the maestro-conduct modules with temp state/log/alert paths and a
// stubbed tmux + skill-registry so buildHeartbeat runs without real binaries.
function fresh(stateDir, opts = {}) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct')) delete require.cache[k];
  }
  process.env.STATE_DIR = stateDir;
  process.env.LOG_FILE = path.join(stateDir, 'conduct.log');
  process.env.ALERT_FILE = path.join(stateDir, 'alerts.jsonl');
  if (opts.wake === undefined || opts.wake === null) {
    delete process.env.CONDUCT_WAKE_EVENTS;
  } else {
    process.env.CONDUCT_WAKE_EVENTS = opts.wake;
  }

  const tmuxPath = require.resolve(LIB('tmux'));
  require.cache[tmuxPath] = {
    id: tmuxPath,
    filename: tmuxPath,
    loaded: true,
    exports: { ensureSession() {}, sendLine() {}, ticketIdFor: (s) => s },
  };
  const srPath = require.resolve(LIB('skill-registry'));
  require.cache[srPath] = {
    id: srPath,
    filename: srPath,
    loaded: true,
    exports: { readTicketSkill: () => 'work', get: () => ({ snapshot: () => ({ phase: 'impl' }) }) },
  };

  const alerts = require(LIB('alerts'));
  const heartbeat = require(LIB('heartbeat'));
  return { alerts, heartbeat };
}

// Capture everything written to process.stderr during fn(); always restore.
function captureStderr(fn) {
  const orig = process.stderr.write;
  let buf = '';
  process.stderr.write = (chunk) => {
    buf += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return buf;
}

function logLines(stateDir) {
  const f = path.join(stateDir, 'conduct.log');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('HEARTBEAT'));
}

test('benign heartbeat writes _heartbeat.json + logfile but never stderr; state-change beat emits immediately', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-route-'));
  const { heartbeat } = fresh(dir); // default allowlist → HEARTBEAT is non-waking

  // First beat: body changed from '' → emits. Must route non-waking.
  const stderr1 = captureStderr(() => heartbeat.maybeEmitHeartbeat(['GH-1-work']));
  assert.equal(stderr1, '', 'HEARTBEAT must not write to the model-wake stderr channel');
  assert.equal(logLines(dir).length, 1, 'HEARTBEAT line appended to the logfile');

  const markerPath = path.join(dir, '_heartbeat.json');
  assert.ok(fs.existsSync(markerPath), '_heartbeat.json marker written under STATE_DIR');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.ok(marker.body.includes('HEARTBEAT'), 'marker carries the latest fleet summary body');
  assert.equal(typeof marker.ts, 'number', 'marker records a numeric timestamp');

  // Same fleet again immediately: body unchanged AND not stale → no new beat.
  const stderr2 = captureStderr(() => heartbeat.maybeEmitHeartbeat(['GH-1-work']));
  assert.equal(stderr2, '', 'still no stderr');
  assert.equal(logLines(dir).length, 1, 'unchanged, non-stale beat is rate-limited (no new line)');

  // Fleet changed (2 active) → state-change beat emits immediately despite the
  // small gap, and still stays off the stderr wake channel.
  const stderr3 = captureStderr(() => heartbeat.maybeEmitHeartbeat(['GH-1-work', 'GH-2-work']));
  assert.equal(stderr3, '', 'state-change HEARTBEAT is still non-waking');
  assert.equal(logLines(dir).length, 2, 'state-change beat emits immediately');
});

test('alert wake routing: default allowlist wakes pr-broken; CONDUCT_WAKE_EVENTS gates + `all` escape hatch', () => {
  // Default allowlist (CONDUCT_WAKE_EVENTS unset) → actionable kinds wake.
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-alert-'));
  const a1 = fresh(dir1);
  assert.equal(typeof a1.alerts.wakesConductor, 'function', 'wakesConductor is exported');
  assert.equal(a1.alerts.wakesConductor('pr-broken'), true, 'pr-broken wakes under the default allowlist');
  assert.equal(a1.alerts.wakesConductor('HEARTBEAT'), false, 'HEARTBEAT is non-waking by default');

  const stderrBroken = captureStderr(() =>
    a1.alerts.alert({ session: 's', ticket: 't', kind: 'pr-broken', sha: 'aaa', instruction: 'fix CI' }),
  );
  assert.ok(stderrBroken.length > 0, 'a default-allowlist pr-broken alert writes to the stderr wake channel');

  // Restricted allowlist: only pr-ready wakes; pr-broken must not.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-restrict-'));
  const a2 = fresh(dir2, { wake: 'pr-ready' });
  assert.equal(a2.alerts.wakesConductor('pr-ready'), true, 'pr-ready wakes under a pr-ready allowlist');
  assert.equal(a2.alerts.wakesConductor('pr-broken'), false, 'pr-broken does NOT wake when not allowlisted');

  const stderrGated = captureStderr(() =>
    a2.alerts.alert({ session: 's', ticket: 't', kind: 'pr-broken', sha: 'bbb', instruction: 'fix CI' }),
  );
  assert.equal(stderrGated, '', 'a non-allowlisted pr-broken alert stays off the wake channel');
  // ...but is never dropped: it still lands in ALERT_FILE.
  const alertFile = path.join(dir2, 'alerts.jsonl');
  assert.ok(fs.existsSync(alertFile), 'non-waking alert is still persisted to ALERT_FILE (not dropped)');

  // Escape hatch: `all` restores always-wake, even for HEARTBEAT.
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-all-'));
  const a3 = fresh(dir3, { wake: 'all' });
  assert.equal(a3.alerts.wakesConductor('HEARTBEAT'), true, '`all` makes every kind wake');
  assert.equal(a3.alerts.wakesConductor('anything-else'), true, '`all` is a blanket escape hatch');
});
