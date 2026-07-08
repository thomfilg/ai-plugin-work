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

test('lost-event kinds wake by default; log-only info lines never do', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-kinds-'));
  const { alerts } = fresh(dir);

  // The four kinds GH-680's audit found silent-but-operator-required.
  for (const kind of ['spinner-hang', 'no-progress', 'kill-during-ci', 'stop-condition-met']) {
    assert.equal(alerts.wakesConductor(kind), true, `${kind} must wake under the default allowlist`);
  }

  // Informational chatter routed with kind:'log-only' lands in the logfile
  // but never on the wake channel.
  assert.equal(alerts.wakesConductor('log-only'), false, 'log-only is never wake-eligible');
  const stderr = captureStderr(() => alerts.log('GH-9-work NUDGE soft: test', { kind: 'log-only' }));
  assert.equal(stderr, '', 'a log-only line writes nothing to stderr');
  const logged = fs.readFileSync(path.join(dir, 'conduct.log'), 'utf8');
  assert.ok(logged.includes('NUDGE soft'), 'the log-only line is still appended to the logfile');
});

test('re-wake throttle: first emission wakes, repeats inside the backoff are silent, backoff doubles, resetCount re-arms', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-throttle-'));
  const { alerts } = fresh(dir);
  delete process.env.PENDING_REWAKE_MIN; // default 30m
  const payload = { session: 'GH-7-work', ticket: 'GH-7', kind: 'spinner-hang', phase: 'impl', instruction: 'check the pane' };

  // 1st emission: wakes.
  const s1 = captureStderr(() => alerts.alert(payload));
  assert.ok(s1.length > 0, 'first emission of a key wakes');

  // 2nd emission immediately after: inside the 30m window → silent on stderr,
  // still persisted to the jsonl.
  const s2 = captureStderr(() => alerts.alert(payload));
  assert.equal(s2, '', 'repeat inside the backoff window must not wake');
  const jsonl = fs.readFileSync(path.join(dir, 'alerts.jsonl'), 'utf8').trim().split('\n');
  assert.equal(jsonl.length, 2, 'the throttled repeat is still persisted (banner re-fire intact)');

  // Age the throttle entry past its window → next emission wakes again and
  // the backoff doubles (30 → 60).
  const throttleFile = path.join(dir, '_wake-throttle.json');
  const map = JSON.parse(fs.readFileSync(throttleFile, 'utf8'));
  const key = Object.keys(map)[0];
  assert.equal(map[key].backoffMin, 30, 'initial backoff equals PENDING_REWAKE_MIN');
  map[key].lastWakeAt = Date.now() - 31 * 60 * 1000;
  fs.writeFileSync(throttleFile, JSON.stringify(map));
  const s3 = captureStderr(() => alerts.alert(payload));
  assert.ok(s3.length > 0, 'a repeat past the backoff window re-wakes');
  const map2 = JSON.parse(fs.readFileSync(throttleFile, 'utf8'));
  assert.equal(map2[key].backoffMin, 60, 'backoff doubles per re-wake');

  // resetCount clears the throttle so a FRESH incident wakes immediately.
  alerts.resetCount(key);
  const map3 = JSON.parse(fs.readFileSync(throttleFile, 'utf8'));
  assert.ok(!(key in map3), 'resetCount clears the throttle entry');
  const s4 = captureStderr(() => alerts.alert(payload));
  assert.ok(s4.length > 0, 'a fresh incident after reset wakes immediately');

  // PENDING_REWAKE_MIN=0 disables throttling entirely.
  process.env.PENDING_REWAKE_MIN = '0';
  const s5 = captureStderr(() => alerts.alert(payload));
  assert.ok(s5.length > 0, 'PENDING_REWAKE_MIN=0 wakes on every repeat');
  delete process.env.PENDING_REWAKE_MIN;

  // Backoff cap: an entry already at the cap must not exceed it.
  const map4 = JSON.parse(fs.readFileSync(throttleFile, 'utf8'));
  map4[key] = { lastWakeAt: Date.now() - 999 * 60 * 1000, backoffMin: 240 };
  fs.writeFileSync(throttleFile, JSON.stringify(map4));
  captureStderr(() => alerts.alert(payload));
  const map5 = JSON.parse(fs.readFileSync(throttleFile, 'utf8'));
  assert.equal(map5[key].backoffMin, 240, 'backoff is capped at PENDING_REWAKE_MAX_MIN');
});

test('new-incident guarantee: a stale throttle entry never swallows the first alert of a fresh incident', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-fresh-'));
  const { alerts } = fresh(dir);
  const payload = { session: 'GH-8-work', ticket: 'GH-8', kind: 'kill-during-ci', phase: 'ci', instruction: 'bootstrap next' };
  // Simulate a leftover backoff entry from a PREVIOUS lifecycle (rotation
  // purged the counts but a stale throttle entry survived): counts file is
  // fresh, throttle says "in backoff".
  const key = alerts.alertKey(payload);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '_wake-throttle.json'),
    JSON.stringify({ [key]: { lastWakeAt: Date.now(), backoffMin: 240 } })
  );
  // count===1 (fresh incident) must clear the stale entry and wake.
  const s = captureStderr(() => alerts.alert(payload));
  assert.ok(s.length > 0, 'first emission of a new incident wakes even with a stale throttle entry');
});

test('logFault: first occurrence wakes, repeats back off, logfile keeps every line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-fault-'));
  const { alerts } = fresh(dir);
  const s1 = captureStderr(() => alerts.logFault('TICK-ERROR GH-3-work: boom', 'tick-error|GH-3-work'));
  assert.ok(s1.length > 0, 'first fault occurrence wakes');
  const s2 = captureStderr(() => alerts.logFault('TICK-ERROR GH-3-work: boom', 'tick-error|GH-3-work'));
  assert.equal(s2, '', 'repeat inside the backoff window does not wake');
  const logged = fs.readFileSync(path.join(dir, 'conduct.log'), 'utf8');
  assert.equal(logged.split('TICK-ERROR').length - 1, 2, 'both fault lines land in the logfile');
  // Distinct fault key is independent.
  const s3 = captureStderr(() => alerts.logFault('TICK-ERROR GH-4-work: boom', 'tick-error|GH-4-work'));
  assert.ok(s3.length > 0, 'a different fault key wakes independently');
});

test('wake-kinds invariant: the banner PENDING_KINDS equals alerts.DEFAULT_WAKE_KINDS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-invariant-'));
  const { alerts } = fresh(dir);
  // The hook executes at require-time, so parse its source instead of loading it.
  const hookSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'hooks', 'active-session-reminder.js'),
    'utf8'
  );
  const m = hookSrc.match(/const PENDING_KINDS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, 'PENDING_KINDS Set literal found in active-session-reminder.js');
  const pendingKinds = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(
    pendingKinds,
    [...alerts.DEFAULT_WAKE_KINDS].sort(),
    'every kind the banner nags about must be able to wake its handler, and vice versa'
  );
});
