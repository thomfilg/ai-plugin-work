// restart-loop guard inside actions.autoRestart.
//
// Contract: if a `-work` session is auto-restarted ≥ RESTART_LOOP_THRESHOLD
// times within RESTART_WINDOW_MIN minutes, declare it WEDGED — stop
// restarting for WEDGED_QUIET_MIN minutes and emit a `kind:'wedged'` alert.
// This is the escalation that prevents endless restart loops on agents
// that auto-restart only to immediately go silent again.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const ACTIONS_PATH = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'actions');

function fakeWorktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rl-wt-'));
}

function freshActions({ stateDir, alertFile, tmuxStub }) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct')) delete require.cache[k];
  }
  process.env.STATE_DIR = stateDir;
  process.env.ALERT_FILE = alertFile;
  process.env.LOG_FILE = path.join(stateDir, '.log');
  process.env.RESTART_LOOP_THRESHOLD = '3';
  process.env.RESTART_WINDOW_MIN = '30';
  process.env.WEDGED_QUIET_MIN = '60';

  // Patch spawnSync so we don't actually call tmux. tmuxStub records calls.
  const cp = require('child_process');
  cp.spawnSync = (cmd, args, opts) => {
    if (cmd === 'tmux') {
      tmuxStub.push({ cmd, args });
      return { status: 0, stdout: '' };
    }
    if (cmd === 'sleep') return { status: 0, stdout: '' };
    return { status: 0, stdout: '' };
  };

  return require(ACTIONS_PATH);
}

test('3rd restart within window declares WEDGED, stops further restarts, emits alert', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-state-'));
  const alertFile = path.join(stateDir, 'alerts.jsonl');
  const wt = fakeWorktree();
  const tmuxStub = [];
  const actions = freshActions({ stateDir, alertFile, tmuxStub });

  const args = { session: 'GH-X-work', ticket: 'GH-X', worktree: wt, silenceSec: 305 };

  // First two restarts succeed.
  assert.equal(actions.autoRestart(args), true, 'restart 1 should proceed');
  assert.equal(actions.autoRestart(args), true, 'restart 2 should proceed');

  // Third call hits the threshold and is suppressed.
  assert.equal(actions.autoRestart(args), false, 'restart 3 must be suppressed as WEDGED');

  // Subsequent restarts during the quiet window are also suppressed.
  assert.equal(
    actions.autoRestart(args),
    false,
    'restart 4 (within quiet window) must be suppressed'
  );

  // Alert file should contain one wedged row.
  const alertLines = fs.readFileSync(alertFile, 'utf8').trim().split('\n').filter(Boolean);
  const wedgedAlerts = alertLines.map(JSON.parse).filter((a) => a.kind === 'wedged');
  assert.equal(
    wedgedAlerts.length,
    1,
    `expected exactly one wedged alert, got ${wedgedAlerts.length}`
  );
  assert.equal(wedgedAlerts[0].session, 'GH-X-work');
  assert.equal(wedgedAlerts[0].restartsInWindow, 3);
});

test('restarts outside the rolling window do not count toward the threshold', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-window-'));
  const alertFile = path.join(stateDir, 'alerts.jsonl');
  const wt = fakeWorktree();
  const tmuxStub = [];
  const actions = freshActions({ stateDir, alertFile, tmuxStub });

  // Seed marker with two restarts that happened 31m ago (outside the 30m
  // window). Use the real state.js so the actions module reads it back.
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct/state')) delete require.cache[k];
  }
  const state = require(path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'state'));
  const longAgo = state.now() - 31 * 60;
  state.write('GH-Y-work', 'restart-loop', { restarts: [longAgo, longAgo + 5] });

  // Now do 2 fresh restarts. Combined with the 2 stale (outside window),
  // we should be at count=2 fresh — still below threshold=3.
  const args = { session: 'GH-Y-work', ticket: 'GH-Y', worktree: wt, silenceSec: 305 };
  assert.equal(
    actions.autoRestart(args),
    true,
    'fresh restart 1 should proceed (stale entries pruned)'
  );
  assert.equal(actions.autoRestart(args), true, 'fresh restart 2 should proceed');

  // No wedged alert yet — only 2 in-window restarts.
  const alertLinesA = fs.existsSync(alertFile)
    ? fs.readFileSync(alertFile, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  assert.equal(alertLinesA.map(JSON.parse).filter((a) => a.kind === 'wedged').length, 0);

  // 3rd in-window restart should now declare WEDGED.
  assert.equal(actions.autoRestart(args), false, 'fresh restart 3 must declare WEDGED');
  const alertLinesB = fs.readFileSync(alertFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(alertLinesB.map(JSON.parse).filter((a) => a.kind === 'wedged').length, 1);
});

test('autoRestart bails early when worktree does not exist (no marker mutation)', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-nowt-'));
  const alertFile = path.join(stateDir, 'alerts.jsonl');
  const tmuxStub = [];
  const actions = freshActions({ stateDir, alertFile, tmuxStub });

  const args = {
    session: 'GH-Z-work',
    ticket: 'GH-Z',
    worktree: '/tmp/definitely-does-not-exist-xyz-' + Date.now(),
    silenceSec: 305,
  };
  assert.equal(actions.autoRestart(args), false);

  // No marker should be created (worktree-missing branch returns before
  // touching state).
  const markerFile = path.join(stateDir, 'GH-Z-work.restart-loop.json');
  assert.equal(
    fs.existsSync(markerFile),
    false,
    'no marker should be written for missing worktree'
  );
});

test('autoRestart skips when dead-end marker is set (slot rotated, do not resurrect)', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-deadend-'));
  const alertFile = path.join(stateDir, 'alerts.jsonl');
  const tmuxStub = [];
  const actions = freshActions({ stateDir, alertFile, tmuxStub });
  const worktree = fakeWorktree();

  // Seed a dead-end marker as freeDeadEndSlot would (per-ticket, killed:true).
  fs.writeFileSync(
    path.join(stateDir, 'GH-DE.dead-end.json'),
    JSON.stringify({
      killed: true,
      freedAt: Math.floor(Date.now() / 1000),
      trigger: 'phase-stall',
    })
  );

  const args = {
    session: 'GH-DE-work',
    ticket: 'GH-DE',
    worktree,
    silenceSec: 600,
  };
  assert.equal(actions.autoRestart(args), false, 'must not resurrect after dead-end rotation');

  // No tmux kill / new-session must have been issued.
  const tmuxCalls = tmuxStub.filter(
    (c) => c.args[0] === 'kill-session' || c.args[0] === 'new-session'
  );
  assert.equal(tmuxCalls.length, 0, 'dead-end guard must short-circuit before any tmux call');

  // No restart-loop marker should be written (guard returns before recording).
  const markerFile = path.join(stateDir, 'GH-DE-work.restart-loop.json');
  assert.equal(
    fs.existsSync(markerFile),
    false,
    'dead-end short-circuit must not touch restart-loop state'
  );
});
