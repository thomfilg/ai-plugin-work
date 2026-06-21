// freeCiPhaseSlot: a -work session reached ci/complete phase, so kill -work +
// -listen panes IMMEDIATELY (no diagnostic probe, no attempt counter) and emit
// a kind=kill-during-ci alert. Idempotent per ticket via the `ci-rotated`
// marker. Disabled by AUTO_FREE_CI_SLOT=0.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const ACTIONS_PATH = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'actions');

function freshActions({ stateDir, alertFile, tmuxStub, env = {} }) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct')) delete require.cache[k];
  }
  process.env.STATE_DIR = stateDir;
  process.env.ALERT_FILE = alertFile;
  process.env.LOG_FILE = path.join(stateDir, '.log');
  delete process.env.AUTO_FREE_CI_SLOT;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const cp = require('child_process');
  cp.spawnSync = (cmd, args) => {
    if (cmd === 'tmux') {
      tmuxStub.push({ cmd, args });
      return { status: 0, stdout: '' };
    }
    return { status: 0, stdout: '' };
  };
  return require(ACTIONS_PATH);
}

test('freeCiPhaseSlot kills -work + -listen on the FIRST call and emits kill-during-ci', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcp-'));
  const alertFile = path.join(stateDir, 'alerts.jsonl');
  const tmuxStub = [];
  const actions = freshActions({ stateDir, alertFile, tmuxStub });

  const result = actions.freeCiPhaseSlot({ session: 'GH-9-work', ticket: 'GH-9' });

  assert.equal(result, true);
  const killed = tmuxStub.filter((c) => c.args[0] === 'kill-session').map((c) => c.args[2]);
  assert.deepEqual(killed.sort(), ['GH-9-listen', 'GH-9-work']);

  const lines = fs.readFileSync(alertFile, 'utf8').trim().split('\n').filter(Boolean);
  const ci = lines.map(JSON.parse).filter((a) => a.kind === 'kill-during-ci');
  assert.equal(ci.length, 1);
});

test('freeCiPhaseSlot sets manifest status awaiting-merge', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fcp-mf-'));
  const stateDir = path.join(root, 'state');
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const alertFile = path.join(stateDir, 'alerts.jsonl');
  const tmuxStub = [];

  const manifestPath = path.join(sessionDir, 'GH-11.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ topic: 'GH-11', tasks: [{ id: 'GH-11', status: 'in_progress', slots: 1 }] })
  );

  const cache = require.cache;
  for (const k of Object.keys(cache)) {
    if (k.includes('/maestro-conduct')) delete cache[k];
  }
  process.env.MAESTRO_SESSION_DIR = sessionDir;
  const actions = freshActions({ stateDir, alertFile, tmuxStub });

  actions.freeCiPhaseSlot({ session: 'GH-11-work', ticket: 'GH-11' });

  const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const task = after.tasks.find((t) => t.id === 'GH-11');
  assert.equal(task.status, 'awaiting-merge');
  delete process.env.MAESTRO_SESSION_DIR;
});

test('freeCiPhaseSlot is idempotent per ticket — second call no-ops', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcp-idem-'));
  const alertFile = path.join(stateDir, 'alerts.jsonl');
  const tmuxStub = [];
  const actions = freshActions({ stateDir, alertFile, tmuxStub });

  const args = { session: 'GH-10-work', ticket: 'GH-10' };
  assert.equal(actions.freeCiPhaseSlot(args), true);
  assert.equal(
    actions.freeCiPhaseSlot(args),
    false,
    'second call must no-op via ci-rotated marker'
  );
  assert.equal(actions.freeCiPhaseSlot(args), false);

  // Only one kill round (2 sessions) and one alert despite three calls.
  const killed = tmuxStub.filter((c) => c.args[0] === 'kill-session');
  assert.equal(killed.length, 2);
  const lines = fs.readFileSync(alertFile, 'utf8').trim().split('\n').filter(Boolean);
  const ci = lines.map(JSON.parse).filter((a) => a.kind === 'kill-during-ci');
  assert.equal(ci.length, 1);
});

test('AUTO_FREE_CI_SLOT=0 disables freeCiPhaseSlot entirely', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcp-off-'));
  const alertFile = path.join(stateDir, 'alerts.jsonl');
  const tmuxStub = [];
  const actions = freshActions({ stateDir, alertFile, tmuxStub, env: { AUTO_FREE_CI_SLOT: '0' } });

  const result = actions.freeCiPhaseSlot({ session: 'GH-12-work', ticket: 'GH-12' });
  assert.equal(result, false);
  assert.equal(tmuxStub.length, 0, 'no tmux kill when disabled');
  assert.equal(fs.existsSync(alertFile), false, 'no alert when disabled');
});

test('freeCiPhaseSlot does NOT send a diagnostic probe', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcp-noprobe-'));
  const alertFile = path.join(stateDir, 'alerts.jsonl');
  const tmuxStub = [];
  const actions = freshActions({ stateDir, alertFile, tmuxStub });

  actions.freeCiPhaseSlot({ session: 'GH-13-work', ticket: 'GH-13' });

  const probes = tmuxStub.filter(
    (c) => c.args[0] === 'send-keys' && (c.args[2] || '').includes('MAESTRO DIAGNOSTIC')
  );
  assert.equal(probes.length, 0, 'must not send a dead-end diagnostic probe');

  // No dead-end-probe alert, and no dead-end attempts incremented.
  const lines = fs.readFileSync(alertFile, 'utf8').trim().split('\n').filter(Boolean);
  const probeAlerts = lines.map(JSON.parse).filter((a) => a.kind === 'dead-end-probe');
  assert.equal(probeAlerts.length, 0);
});

test('maybeRotateOnPhase delegates to freeCiPhaseSlot only for ci/complete + restartEligible', () => {
  const calls = [];
  const stubActions = {
    freeCiPhaseSlot: (args) => {
      calls.push(args);
      return true;
    },
  };
  const ciGate = require(
    path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'ci-gate-rotation')
  );
  const restartEligible = () => true;

  // Non-ci phase: no delegation.
  assert.equal(
    ciGate.maybeRotateOnPhase({
      ctx: { session: 's', ticket: 't', phase: 'implement' },
      state: {},
      actions: stubActions,
      restartEligible,
    }),
    false
  );
  assert.equal(calls.length, 0);

  // ci phase + eligible: delegates.
  assert.equal(
    ciGate.maybeRotateOnPhase({
      ctx: { session: 's', ticket: 't', phase: 'ci' },
      state: {},
      actions: stubActions,
      restartEligible,
    }),
    true
  );
  assert.deepEqual(calls[calls.length - 1], { session: 's', ticket: 't' });

  // complete phase + eligible: delegates.
  ciGate.maybeRotateOnPhase({
    ctx: { session: 's', ticket: 't', phase: 'complete' },
    state: {},
    actions: stubActions,
    restartEligible,
  });
  assert.equal(calls.length, 2);

  // ci phase but NOT restartEligible: no delegation.
  ciGate.maybeRotateOnPhase({
    ctx: { session: 's', ticket: 't', phase: 'ci' },
    state: {},
    actions: stubActions,
    restartEligible: () => false,
  });
  assert.equal(calls.length, 2);
});
