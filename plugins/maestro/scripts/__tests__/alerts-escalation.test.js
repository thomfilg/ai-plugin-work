// alerts.alert() returns {count} reflecting how many times the same
// (session, kind, sha-or-phase) has been emitted. Used by maestro-conduct.js
// to escalate to freeDeadEndSlot when the same alert re-fires too often.
// Also: alerts without an `instruction` field are dropped (log-only).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const ALERTS_PATH = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'alerts');

function freshAlerts(stateDir, alertFile) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct')) delete require.cache[k];
  }
  process.env.STATE_DIR = stateDir;
  process.env.ALERT_FILE = alertFile;
  process.env.LOG_FILE = path.join(stateDir, '.log');
  // Stub tmux so we don't hit the real binary.
  const cp = require('child_process');
  cp.spawnSync = () => ({ status: 0, stdout: '' });
  // Stub tmux.ensureSession via the module the alerts depends on. Easiest:
  // monkey-patch after require by also stubbing the tmux module's exports.
  const tmuxPath = require.resolve(path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'tmux'));
  require.cache[tmuxPath] = {
    id: tmuxPath,
    filename: tmuxPath,
    loaded: true,
    exports: { ensureSession: () => {}, sendLine: () => {} },
  };
  return require(ALERTS_PATH);
}

test('alert without instruction is dropped (no alert-file write)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-drop-'));
  const file = path.join(dir, 'alerts.jsonl');
  const alerts = freshAlerts(dir, file);
  const r = alerts.alert({ session: 's', ticket: 't', kind: 'wedged' });
  assert.equal(r.count, 0);
  assert.equal(fs.existsSync(file), false, 'no alert file when instruction missing');
});

test('alert with instruction writes to alert file and returns count=1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-1-'));
  const file = path.join(dir, 'alerts.jsonl');
  const alerts = freshAlerts(dir, file);
  const r = alerts.alert({
    session: 's',
    ticket: 't',
    kind: 'question-pending',
    sha: 'abc',
    instruction: 'capture pane and pick legitimate option',
  });
  assert.equal(r.count, 1);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.repeatCount, 1);
  assert.equal(payload.instruction, 'capture pane and pick legitimate option');
});

test('repeated alert on same (session,kind,sha) increments count + prefixes instruction with [REPEAT N]', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-rep-'));
  const file = path.join(dir, 'alerts.jsonl');
  const alerts = freshAlerts(dir, file);
  const args = {
    session: 's',
    ticket: 't',
    kind: 'question-pending',
    sha: 'aaa',
    instruction: 'do the thing',
  };
  assert.equal(alerts.alert(args).count, 1);
  assert.equal(alerts.alert(args).count, 2);
  assert.equal(alerts.alert(args).count, 3);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].instruction, 'do the thing');
  assert.equal(lines[1].instruction, '[REPEAT 2] do the thing');
  assert.equal(lines[2].instruction, '[REPEAT 3] do the thing');
});

test('different SHA resets the count (new state, fresh emit)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-sha-'));
  const file = path.join(dir, 'alerts.jsonl');
  const alerts = freshAlerts(dir, file);
  const base = { session: 's', ticket: 't', kind: 'pr-broken', instruction: 'fix CI' };
  assert.equal(alerts.alert({ ...base, sha: 'aaa' }).count, 1);
  assert.equal(alerts.alert({ ...base, sha: 'aaa' }).count, 2);
  assert.equal(alerts.alert({ ...base, sha: 'bbb' }).count, 1, 'new SHA must start fresh');
});

test('resetCount clears a specific (session,kind,sha) key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-reset-'));
  const file = path.join(dir, 'alerts.jsonl');
  const alerts = freshAlerts(dir, file);
  const args = { session: 's', ticket: 't', kind: 'wedged', sha: 'x', instruction: 'inspect' };
  alerts.alert(args);
  alerts.alert(args);
  alerts.resetCount(alerts.alertKey(args));
  assert.equal(alerts.alert(args).count, 1, 'count starts at 1 after reset');
});
