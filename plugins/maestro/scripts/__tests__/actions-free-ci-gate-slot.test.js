// freeCIGateSlot: kill -work + -listen panes when PR is at CI gate, emit
// kind=slot-freed alert. Idempotent per SHA. Disabled by AUTO_FREE_CI_SLOT=0.

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

test('freeCIGateSlot kills -work + -listen and emits slot-freed alert', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcg-'));
  const alertFile = path.join(stateDir, 'alerts.jsonl');
  const tmuxStub = [];
  const actions = freshActions({ stateDir, alertFile, tmuxStub });

  const result = actions.freeCIGateSlot({
    session: 'GH-9-listen',
    ticket: 'GH-9',
    prNumber: 999,
    sha: 'abc123',
  });

  assert.equal(result, true);
  const killed = tmuxStub.filter((c) => c.args[0] === 'kill-session').map((c) => c.args[2]);
  assert.deepEqual(killed.sort(), ['GH-9-listen', 'GH-9-work']);

  const lines = fs.readFileSync(alertFile, 'utf8').trim().split('\n').filter(Boolean);
  const slotFreed = lines.map(JSON.parse).filter((a) => a.kind === 'slot-freed');
  assert.equal(slotFreed.length, 1);
  assert.equal(slotFreed[0].prNumber, 999);
  assert.equal(slotFreed[0].sha, 'abc123');
});

test('freeCIGateSlot is idempotent on the same SHA', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcg-idem-'));
  const alertFile = path.join(stateDir, 'alerts.jsonl');
  const tmuxStub = [];
  const actions = freshActions({ stateDir, alertFile, tmuxStub });

  const args = { session: 'GH-10-listen', ticket: 'GH-10', prNumber: 10, sha: 'same' };
  assert.equal(actions.freeCIGateSlot(args), true);
  assert.equal(actions.freeCIGateSlot(args), false, 'second call same SHA must no-op');
  assert.equal(actions.freeCIGateSlot(args), false);

  // Only one slot-freed alert despite three calls (alert is sha-idempotent).
  const lines = fs.readFileSync(alertFile, 'utf8').trim().split('\n').filter(Boolean);
  const slotFreed = lines.map(JSON.parse).filter((a) => a.kind === 'slot-freed');
  assert.equal(slotFreed.length, 1);

  // Tmux kill fires on EVERY call (defensive against zombie sessions
  // resurrected by autoRestart between ticks). 3 calls × 2 suffixes = 6.
  const killed = tmuxStub.filter((c) => c.args[0] === 'kill-session');
  assert.equal(killed.length, 6);
});

test('freeCIGateSlot re-fires when SHA changes (operator pushed a new commit)', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcg-sha-'));
  const alertFile = path.join(stateDir, 'alerts.jsonl');
  const tmuxStub = [];
  const actions = freshActions({ stateDir, alertFile, tmuxStub });

  assert.equal(
    actions.freeCIGateSlot({ session: 's', ticket: 't', prNumber: 1, sha: 'aaa' }),
    true
  );
  assert.equal(
    actions.freeCIGateSlot({ session: 's', ticket: 't', prNumber: 1, sha: 'bbb' }),
    true
  );
  const lines = fs.readFileSync(alertFile, 'utf8').trim().split('\n').filter(Boolean);
  const slotFreed = lines.map(JSON.parse).filter((a) => a.kind === 'slot-freed');
  assert.equal(slotFreed.length, 2);
});

test('AUTO_FREE_CI_SLOT=0 disables the action entirely', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcg-off-'));
  const alertFile = path.join(stateDir, 'alerts.jsonl');
  const tmuxStub = [];
  const actions = freshActions({ stateDir, alertFile, tmuxStub, env: { AUTO_FREE_CI_SLOT: '0' } });

  const result = actions.freeCIGateSlot({ session: 's', ticket: 't', prNumber: 1, sha: 'x' });
  assert.equal(result, false);
  assert.equal(tmuxStub.length, 0, 'no tmux kill when disabled');
  assert.equal(fs.existsSync(alertFile), false, 'no alert when disabled');
});
