// GH-698 — tiered re-wake policy + alert resolution + fleet-empty debounce.
//
// The uniform exponential backoff let a BLOCKING alert (agent idle-waiting on
// the operator) decay to once-every-4-hours — an 8h commit stall and a
// full-night idle-block both ran unseen. These tests pin the new contract:
//   (a) BLOCKING kinds (ACTION_REQUIRED_KINDS) re-wake on a FLAT
//       BLOCKING_REWAKE_MIN cadence — never doubling;
//   (b) cosmetic kinds keep the doubling PENDING_REWAKE_MIN backoff;
//   (c) alerts.resolve() retires a pending incident: counts + throttle purged,
//       an `alert-resolved` record appended, no-op when nothing was pending;
//   (d) commit-stall is a default wake kind;
//   (e) fleet-empty needs 2 consecutive empty ticks (single-tick tmux listing
//       flaps must not bill a fault wake).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const LIB = (name) => path.resolve(__dirname, '..', 'lib', 'maestro-conduct', name);

function fresh(stateDir) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct')) delete require.cache[k];
  }
  process.env.STATE_DIR = stateDir;
  process.env.LOG_FILE = path.join(stateDir, 'conduct.log');
  process.env.ALERT_FILE = path.join(stateDir, 'alerts.jsonl');
  delete process.env.CONDUCT_WAKE_EVENTS;

  const tmuxPath = require.resolve(LIB('tmux'));
  require.cache[tmuxPath] = {
    id: tmuxPath,
    filename: tmuxPath,
    loaded: true,
    exports: { ensureSession() {}, sendLine() {}, ticketIdFor: (s) => s },
  };

  const alerts = require(LIB('alerts'));
  const fleetEmpty = require(LIB('fleet-empty'));
  return { alerts, fleetEmpty };
}

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

test('blocking kinds re-wake on a flat BLOCKING_REWAKE_MIN cadence — no doubling', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-block-'));
  const { alerts } = fresh(dir);
  delete process.env.PENDING_REWAKE_MIN;
  delete process.env.BLOCKING_REWAKE_MIN; // default 5m
  const payload = {
    session: 'GH-1-work',
    ticket: 'GH-1',
    kind: 'stuck-input',
    phase: 'implement',
    instruction: 'submit or clear the composer text',
  };

  const s1 = captureStderr(() => alerts.alert(payload));
  assert.ok(s1.length > 0, 'first emission of a blocking key wakes');

  const s2 = captureStderr(() => alerts.alert(payload));
  assert.equal(s2, '', 'repeat inside the flat blocking window is silent');

  const throttleFile = path.join(dir, '_wake-throttle.json');
  let map = JSON.parse(fs.readFileSync(throttleFile, 'utf8'));
  const key = Object.keys(map)[0];
  assert.equal(map[key].backoffMin, 5, 'blocking floor equals BLOCKING_REWAKE_MIN');

  // Age past the flat window → re-wakes, and the cadence does NOT double.
  map[key].lastWakeAt = Date.now() - 6 * 60 * 1000;
  fs.writeFileSync(throttleFile, JSON.stringify(map));
  const s3 = captureStderr(() => alerts.alert(payload));
  assert.ok(s3.length > 0, 'a repeat past the flat window re-wakes');
  map = JSON.parse(fs.readFileSync(throttleFile, 'utf8'));
  assert.equal(map[key].backoffMin, 5, 'blocking cadence stays flat — never doubles');

  // BLOCKING_REWAKE_MIN=0 → every blocking repeat wakes.
  process.env.BLOCKING_REWAKE_MIN = '0';
  const s4 = captureStderr(() => alerts.alert(payload));
  assert.ok(s4.length > 0, 'BLOCKING_REWAKE_MIN=0 wakes on every blocking repeat');
  delete process.env.BLOCKING_REWAKE_MIN;

  // PENDING_REWAKE_MIN=0 is the documented GLOBAL kill-switch: it disables the
  // throttle for BOTH tiers, even with a non-zero blocking cadence configured.
  process.env.PENDING_REWAKE_MIN = '0';
  process.env.BLOCKING_REWAKE_MIN = '5';
  const s5 = captureStderr(() => alerts.alert(payload));
  assert.ok(s5.length > 0, 'PENDING_REWAKE_MIN=0 disables the blocking tier too');
  delete process.env.PENDING_REWAKE_MIN;
  delete process.env.BLOCKING_REWAKE_MIN;
});

test('cosmetic kinds keep the doubling backoff while blocking kinds stay flat', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-cosm-'));
  const { alerts } = fresh(dir);
  delete process.env.PENDING_REWAKE_MIN; // default 30m
  delete process.env.BLOCKING_REWAKE_MIN;
  const cosmetic = {
    session: 'GH-2-work',
    ticket: 'GH-2',
    kind: 'spinner-hang',
    phase: 'implement',
    instruction: 'inspect the spinner',
  };
  captureStderr(() => alerts.alert(cosmetic));
  const throttleFile = path.join(dir, '_wake-throttle.json');
  let map = JSON.parse(fs.readFileSync(throttleFile, 'utf8'));
  const key = Object.keys(map)[0];
  assert.equal(map[key].backoffMin, 30, 'cosmetic floor equals PENDING_REWAKE_MIN');
  map[key].lastWakeAt = Date.now() - 31 * 60 * 1000;
  fs.writeFileSync(throttleFile, JSON.stringify(map));
  captureStderr(() => alerts.alert(cosmetic));
  map = JSON.parse(fs.readFileSync(throttleFile, 'utf8'));
  assert.equal(map[key].backoffMin, 60, 'cosmetic backoff still doubles per re-wake');
});

test('resolve() purges counts + throttle, appends an alert-resolved record, and no-ops when idle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-resolve-'));
  const { alerts } = fresh(dir);
  delete process.env.BLOCKING_REWAKE_MIN;
  const payload = {
    session: 'GH-3-work',
    ticket: 'GH-3',
    kind: 'stuck-input',
    phase: 'implement',
    instruction: 'submit or clear the composer text',
  };
  captureStderr(() => alerts.alert(payload));
  captureStderr(() => alerts.alert(payload)); // repeatCount now 2

  assert.equal(
    alerts.resolve('GH-3-work', 'stuck-input', 'composer cleared'),
    true,
    'resolve reports a retired incident'
  );
  const counts = JSON.parse(fs.readFileSync(path.join(dir, '_alert-counts.json'), 'utf8'));
  assert.ok(
    !Object.keys(counts).some((k) => k.startsWith('GH-3-work|stuck-input|')),
    'repeat counts for every phase variant are purged'
  );
  const lines = fs
    .readFileSync(path.join(dir, 'alerts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const record = lines[lines.length - 1];
  assert.equal(record.kind, 'alert-resolved');
  assert.equal(record.resolvesKind, 'stuck-input');
  assert.equal(record.session, 'GH-3-work');

  // Nothing pending anymore → strict no-op (no record spam on every tick).
  assert.equal(alerts.resolve('GH-3-work', 'stuck-input'), false, 'idle resolve is a no-op');
  const after = fs.readFileSync(path.join(dir, 'alerts.jsonl'), 'utf8').trim().split('\n');
  assert.equal(after.length, lines.length, 'no duplicate resolution record');

  // A recurrence is a FRESH incident: repeatCount restarts and it wakes.
  const s = captureStderr(() => alerts.alert(payload));
  assert.ok(s.length > 0, 'post-resolution recurrence wakes immediately');
  const recurrence = fs
    .readFileSync(path.join(dir, 'alerts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .pop();
  assert.equal(recurrence.repeatCount, 1, 'repeat count restarts after resolution');
});

test('commit-stall is a default wake kind (GH-698: 8h stalls were log-only)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-commit-'));
  const { alerts } = fresh(dir);
  assert.equal(alerts.wakesConductor('commit-stall'), true);
  assert.equal(
    alerts.ACTION_REQUIRED_KINDS.has('commit-stall'),
    false,
    'commit-stall is investigate-tier: wakes + banners, but never stop-blocking'
  );
});

test('fleet-empty: a single-tick vanish never alerts; two consecutive empty ticks alert once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-fleet-'));
  const { fleetEmpty } = fresh(dir);
  const eligible = (s) => s.endsWith('-work');

  // Blip: 1 → 0 → 1. Observed live (GH-698): a healthy fleet "vanished" for
  // one tick under load and returned the next.
  const blip = captureStderr(() => {
    fleetEmpty.checkFleetEmpty(['GH-1-work'], eligible);
    fleetEmpty.checkFleetEmpty([], eligible);
    fleetEmpty.checkFleetEmpty(['GH-1-work'], eligible);
  });
  assert.ok(!blip.includes('FLEET-EMPTY'), 'single-tick flap is debounced');

  // Real death: 1 → 0 → 0 → alert on the second empty tick, exactly once.
  const death = captureStderr(() => {
    fleetEmpty.checkFleetEmpty([], eligible);
    fleetEmpty.checkFleetEmpty([], eligible);
  });
  assert.ok(death.includes('FLEET-EMPTY'), 'second consecutive empty tick raises the fault');
  const repeat = captureStderr(() => fleetEmpty.checkFleetEmpty([], eligible));
  assert.ok(!repeat.includes('FLEET-EMPTY'), 'fires once per vanish incident');
});
