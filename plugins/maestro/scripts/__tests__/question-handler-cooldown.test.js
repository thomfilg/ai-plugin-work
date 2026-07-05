// question-handler.js — GH-548 regression tests.
//
// The old handler re-alerted EVERY tick once a question passed Q_WAIT_MIN,
// so DEAD_END_REEMITS=3 killed a healthy waiting agent ~2 minutes after the
// first alert (12 of 14 dead-end markers on this machine were question kills,
// one fired while the operator was typing into the pane). The contract now:
//   - re-emits respect the Q_RE_NUDGE_MIN cooldown
//   - dead-end escalation additionally requires Q_DEAD_END_MIN of pending time
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MOD = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'question-handler.js');
const { handleQuestion, Q_RE_NUDGE_MIN, Q_DEAD_END_MIN } = require(MOD);

// Minimal in-memory `state` double matching the injected surface.
function fakeState(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    read: (k, kind) => store.get(`${k}|${kind}`) || null,
    write: (k, kind, v) => store.set(`${k}|${kind}`, v),
    now: () => Math.floor(Date.now() / 1000),
    minutesSince: (secs) => Math.floor((Math.floor(Date.now() / 1000) - secs) / 60),
    _store: store,
  };
}

function run({ marker, alertCount = 1 }) {
  const state = fakeState();
  if (marker) state.write('S-work', 'question', marker);
  const alerts = [];
  const deadEnds = [];
  const actions = { alert: (p) => (alerts.push(p), { count: alertCount }) };
  const ctx = { session: 'S-work', ticket: 'S', phase: null, skill: 'qc-work', pane: '❯ 1. Yes' };
  handleQuestion({
    ctx,
    qHit: { options: ['1. Yes'], promptKind: 'menu' },
    state,
    actions,
    qWaitMin: 3,
    maybeEscalateToDeadEnd: (c, kind, count) => deadEnds.push({ kind, count }),
  });
  return { alerts, deadEnds, state };
}

test('first sighting arms the marker without alerting', () => {
  const { alerts, state } = run({ marker: null });
  assert.equal(alerts.length, 0);
  assert.ok(state.read('S-work', 'question'), 'marker must be armed');
});

test('re-emit respects the Q_RE_NUDGE_MIN cooldown', () => {
  const now = Math.floor(Date.now() / 1000);
  // Alerted 1 minute ago → within cooldown → silent.
  const { alerts } = run({
    marker: { startedAt: now - 20 * 60, alerted: true, lastAlertAt: now - 60 },
  });
  assert.equal(alerts.length, 0, 'must not re-alert inside the cooldown');

  // Alerted past the cooldown → re-emits.
  const { alerts: alerts2 } = run({
    marker: {
      startedAt: now - 20 * 60,
      alerted: true,
      lastAlertAt: now - (Q_RE_NUDGE_MIN + 1) * 60,
    },
  });
  assert.equal(alerts2.length, 1, 'must re-alert after the cooldown');
});

test('dead-end escalation requires Q_DEAD_END_MIN of pending time', () => {
  const now = Math.floor(Date.now() / 1000);
  // Pending 10m with a high repeat count: alert fires, dead-end must NOT.
  const young = run({
    marker: { startedAt: now - 10 * 60, alerted: true, lastAlertAt: now - 60 * 60 },
    alertCount: 99,
  });
  assert.equal(young.alerts.length, 1);
  assert.equal(young.deadEnds.length, 0, 'a 10m-old question must never trigger rotation');

  // Pending past Q_DEAD_END_MIN → escalation path opens.
  const old = run({
    marker: {
      startedAt: now - (Q_DEAD_END_MIN + 5) * 60,
      alerted: true,
      lastAlertAt: now - 60 * 60,
    },
    alertCount: 99,
  });
  assert.equal(old.deadEnds.length, 1);
});

test('alert payload names the skill and demands skill-aware answering', () => {
  const now = Math.floor(Date.now() / 1000);
  const { alerts } = run({
    marker: { startedAt: now - 5 * 60, alerted: false },
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].skill, 'qc-work');
  assert.match(alerts[0].instruction, /\/qc-work/, 'instruction must name the agent command');
});
