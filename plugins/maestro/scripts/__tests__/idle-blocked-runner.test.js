// idle-blocked-runner.js — policy layer for the GH-698 A1 backstop detector:
// phase exemptions, announced-wait suppression, alert cadence, resolve-on-
// clear, and the question-interlude hand-off (noteSiblingOwned).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const LIB = (name) => path.resolve(__dirname, '..', 'lib', 'maestro-conduct', name);

function fresh(stateDir, opts = {}) {
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
  const pbPath = require.resolve(LIB('pane-busy'));
  require.cache[pbPath] = {
    id: pbPath,
    filename: pbPath,
    loaded: true,
    exports: { paneHasLiveSubprocess: () => !!opts.busy, panePid: () => null },
  };
  return {
    runner: require(LIB('idle-blocked-runner')),
    state: require(LIB('state')),
    alerts: require(LIB('alerts')),
  };
}

const restartEligible = (s) => /-work$/.test(s);
const IDLE_PANE = '● Done.\n\n❯ \n';

function ctxFor(overrides = {}) {
  return {
    session: 'GH-7-work',
    ticket: 'GH-7',
    phase: 'implement',
    skill: 'work',
    pane: IDLE_PANE,
    ...overrides,
  };
}

function alertRecords(dir) {
  const f = path.join(dir, 'alerts.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('confirmed idle-blocked emits one blocking alert, then honors the re-emit cooldown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibr-'));
  const { runner, state } = fresh(dir);
  state.write('GH-7-work', 'idle-blocked', { ticks: 2, firstSeenAt: state.now() - 120 });
  runner.runIdleBlockedDetector(ctxFor(), { restartEligible });
  const first = alertRecords(dir);
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, 'idle-blocked');
  assert.equal(first[0].action_required, true, 'idle-blocked is a BLOCKING (action-required) kind');
  assert.match(first[0].instruction, /Do NOT kill\/restart/);

  runner.runIdleBlockedDetector(ctxFor(), { restartEligible });
  assert.equal(alertRecords(dir).length, 1, 'repeat inside IDLE_BLOCKED_RE_EMIT_MIN stays quiet');
});

test('exempt phases, announced human-waits, and helper sessions never alert — and the streak resets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibr-'));
  const { runner, state } = fresh(dir);
  for (const phase of ['complete', 'wait_merge', 'ci', 'cleanup', 'reports']) {
    state.write('GH-7-work', 'idle-blocked', { ticks: 9, firstSeenAt: state.now() - 3600 });
    runner.runIdleBlockedDetector(ctxFor({ phase }), { restartEligible });
    // Exempt idle is healthy: the accumulated streak must not survive the
    // phase, or the first idle tick after leaving it fires instantly with an
    // elapsedMin spanning the whole benign wait (GH-698 review).
    assert.equal(state.read('GH-7-work', 'idle-blocked'), null, `${phase}: streak dropped`);
  }
  state.write('GH-7-work', 'idle-blocked', { ticks: 9, firstSeenAt: state.now() - 3600 });
  runner.runIdleBlockedDetector(ctxFor({ pane: 'CI is green — Merge when ready\n❯ \n' }), {
    restartEligible,
  });
  assert.equal(state.read('GH-7-work', 'idle-blocked'), null, 'announced wait: streak dropped');
  state.write('GH-7-listen', 'idle-blocked', { ticks: 9, firstSeenAt: state.now() - 3600 });
  runner.runIdleBlockedDetector(ctxFor({ session: 'GH-7-listen' }), { restartEligible });
  assert.equal(alertRecords(dir).length, 0, 'no alert on any suppressed path');
});

test('holdsSilenceRestart: true only while the FIRST alert is inside IDLE_BLOCKED_HOLD_MIN', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibr-'));
  const { runner, state } = fresh(dir);
  assert.equal(runner.holdsSilenceRestart('GH-7-work'), false, 'no pending alert → no hold');
  state.write('GH-7-work', 'idle-blocked-alert', {
    lastAt: state.now(),
    firstAlertAt: state.now() - 5 * 60,
  });
  assert.equal(runner.holdsSilenceRestart('GH-7-work'), true, 'fresh incident → hold');
  // lastAt refreshes on every re-emit; the hold must key on firstAlertAt or
  // it renews forever and self-heal never resumes.
  state.write('GH-7-work', 'idle-blocked-alert', {
    lastAt: state.now(),
    firstAlertAt: state.now() - (runner.IDLE_BLOCKED_HOLD_MIN + 1) * 60,
  });
  assert.equal(runner.holdsSilenceRestart('GH-7-work'), false, 'hold lapses from FIRST alert');
});

test('silence runner: holds the restart during the grace window, then restart resolves the pending alert', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibr-'));
  const { runner, state } = fresh(dir);
  // Stub the silence detector (always a hit) and actions (restart succeeds).
  const silDetPath = require.resolve(LIB(path.join('detectors', 'silence.js')));
  require.cache[silDetPath] = {
    id: silDetPath,
    filename: silDetPath,
    loaded: true,
    exports: { detect: () => ({ hit: true, kind: 'silent', silenceSec: 999 }) },
  };
  const actionsPath = require.resolve(LIB('actions.js'));
  const restarted = [];
  require.cache[actionsPath] = {
    id: actionsPath,
    filename: actionsPath,
    loaded: true,
    exports: { autoRestart: (a) => (restarted.push(a.session), true), alert: () => ({ count: 1 }) },
  };
  const silenceRunner = require(LIB('silence-runner.js'));

  // A REAL pending incident: the runner emits the alert (persisting repeat
  // counts + the alert marker with firstAlertAt=now) — resolve() is a no-op
  // without persisted state, so a synthetic marker alone can't test the wipe.
  state.write('GH-7-work', 'idle-blocked', { ticks: 2, firstSeenAt: state.now() - 120 });
  runner.runIdleBlockedDetector(ctxFor(), { restartEligible });
  assert.equal(alertRecords(dir).filter((r) => r.kind === 'idle-blocked').length, 1);

  // Inside the hold window: restart is deferred.
  assert.equal(silenceRunner.runSilenceDetector(ctxFor(), { restartEligible }), false);
  assert.equal(restarted.length, 0, 'restart held while the operator grace window is open');

  // Hold lapsed: restart proceeds AND retires the pending incident.
  const marker = state.read('GH-7-work', 'idle-blocked-alert');
  state.write('GH-7-work', 'idle-blocked-alert', {
    ...marker,
    firstAlertAt: state.now() - (runner.IDLE_BLOCKED_HOLD_MIN + 1) * 60,
  });
  assert.equal(silenceRunner.runSilenceDetector(ctxFor(), { restartEligible }), true);
  assert.deepEqual(restarted, ['GH-7-work'], 'self-heal resumes after the hold');
  const resolved = alertRecords(dir).filter((r) => r.kind === 'alert-resolved');
  assert.equal(resolved.length, 1, 'the wipe path retires the incident (GH-698 review)');
  assert.equal(resolved[0].resolvesKind, 'idle-blocked');
  assert.equal(state.read('GH-7-work', 'idle-blocked-alert'), null);
});

test('agent active again → detector cleared → runner resolves the pending alert', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibr-'));
  const { runner, state } = fresh(dir);
  state.write('GH-7-work', 'idle-blocked', { ticks: 2, firstSeenAt: state.now() - 120 });
  runner.runIdleBlockedDetector(ctxFor(), { restartEligible });
  assert.equal(alertRecords(dir).length, 1);

  const busyPane = '✻ Cooking… (3m 12s · ↓ 2.1k tokens)\n❯ ';
  runner.runIdleBlockedDetector(ctxFor({ pane: busyPane }), { restartEligible });
  const records = alertRecords(dir);
  const resolved = records.filter((r) => r.kind === 'alert-resolved');
  assert.equal(resolved.length, 1, 'clear path appends an alert-resolved record');
  assert.equal(resolved[0].resolvesKind, 'idle-blocked');
  assert.equal(state.read('GH-7-work', 'idle-blocked-alert'), null, 'cadence marker dropped');
});

test('noteSiblingOwned: a question interlude breaks the idle streak and retires the alert', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibr-'));
  const { runner, state } = fresh(dir);
  // Streak at 2 ticks + a pending alert marker, then a question appears.
  state.write('GH-7-work', 'idle-blocked', { ticks: 2, firstSeenAt: state.now() - 120 });
  state.write('GH-7-work', 'idle-blocked-alert', { lastAt: state.now() });
  runner.noteSiblingOwned('GH-7-work', 'question prompt visible');
  assert.equal(state.read('GH-7-work', 'idle-blocked'), null, 'tick counter dropped');
  assert.equal(state.read('GH-7-work', 'idle-blocked-alert'), null, 'alert marker dropped');
  // No-op when nothing is armed (called every question tick).
  runner.noteSiblingOwned('GH-7-work', 'question prompt visible');
  assert.equal(state.read('GH-7-work', 'idle-blocked'), null);
});
