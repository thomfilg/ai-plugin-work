// freeDeadEndSlot grace window: after the attempt-1 diagnostic probe, a
// DEAD_END_PROBE_GRACE_MIN window must elapse before a re-emit advances to
// attempt 2 and kill+rotate. Re-emits inside the window no-op (no attempt
// bump, no kill, no alert) so the agent has time to answer the probe.
//
// Timing is controlled deterministically by pre-seeding the `dead-end` state
// marker's diagnosedAt relative to state.now() — no wall-clock sleeps.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const ACTIONS_PATH = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'actions');
const STATE_PATH = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'state');

// GRACE default is 3 minutes (DEAD_END_PROBE_GRACE_MIN). Tests pin it via env
// so the assertions are independent of the default's value.
const GRACE_MIN = 3;

function freshEnv({ stateDir, alertFile, sessionDir, env = {} }) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct')) delete require.cache[k];
  }
  process.env.STATE_DIR = stateDir;
  process.env.ALERT_FILE = alertFile;
  process.env.LOG_FILE = path.join(stateDir, '.log');
  process.env.MAESTRO_SESSION_DIR = sessionDir;
  process.env.DEAD_END_PROBE_GRACE_MIN = String(GRACE_MIN);
  delete process.env.AUTO_FREE_DEAD_END;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const cp = require('child_process');
  const tmuxStub = [];
  cp.spawnSync = (cmd, args) => {
    if (cmd === 'tmux') {
      tmuxStub.push({ cmd, args });
      return { status: 0, stdout: '' };
    }
    return { status: 0, stdout: '' };
  };
  const actions = require(ACTIONS_PATH);
  const state = require(STATE_PATH);
  return { actions, state, tmuxStub };
}

function setup(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-end-grace-'));
  const stateDir = path.join(root, 'state');
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const alertFile = path.join(stateDir, 'alerts.jsonl');
  return { root, stateDir, sessionDir, alertFile, ...overrides };
}

function seedManifest(sessionDir, ticket, task = {}) {
  const manifestPath = path.join(sessionDir, `${ticket}.json`);
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      topic: ticket,
      tasks: [{ id: ticket, status: 'in_progress', slots: 1, ...task }],
    })
  );
  return manifestPath;
}

function readTask(manifestPath, ticket) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).tasks.find((t) => t.id === ticket);
}

function alerts(alertFile) {
  if (!fs.existsSync(alertFile)) return [];
  return fs.readFileSync(alertFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function kills(tmuxStub) {
  return tmuxStub.filter((c) => c.args[0] === 'kill-session');
}

const TICKET = 'GH-77';

test('within grace window: re-emit no-ops — no kill, no attempt bump, no alert', () => {
  const { stateDir, sessionDir, alertFile } = setup();
  const manifestPath = seedManifest(sessionDir, TICKET, { attempts: 1 });
  const { actions, state, tmuxStub } = freshEnv({ stateDir, alertFile, sessionDir });

  // Probe already sent (attempt 1), diagnosedAt = now → fully inside grace.
  state.write(TICKET, 'dead-end', {
    diagnosed: true,
    diagnosedAt: state.now(),
    trigger: 'question',
    attempts: 1,
  });

  const result = actions.freeDeadEndSlot({
    session: `${TICKET}-work`,
    ticket: TICKET,
    kind: 'question',
    repeatCount: 5,
  });

  assert.equal(result, false, 'must no-op inside grace window');
  assert.equal(kills(tmuxStub).length, 0, 'no tmux kill-session inside grace');
  assert.equal(readTask(manifestPath, TICKET).attempts, 1, 'attempts must stay 1');
  const ended = alerts(alertFile).filter(
    (a) => a.kind === 'dead-end' || a.kind === 'dead-end-probe'
  );
  assert.equal(ended.length, 0, 'no dead-end/probe alert inside grace');
});

test('after grace window: re-emit proceeds — increments to attempt 2 and kill+rotate', () => {
  const { stateDir, sessionDir, alertFile } = setup();
  const manifestPath = seedManifest(sessionDir, TICKET, { attempts: 1 });
  const { actions, state, tmuxStub } = freshEnv({ stateDir, alertFile, sessionDir });

  // diagnosedAt pushed past the grace window (+60s margin) → grace elapsed.
  state.write(TICKET, 'dead-end', {
    diagnosed: true,
    diagnosedAt: state.now() - (GRACE_MIN * 60 + 60),
    trigger: 'question',
    attempts: 1,
  });

  const result = actions.freeDeadEndSlot({
    session: `${TICKET}-work`,
    ticket: TICKET,
    kind: 'question',
    repeatCount: 5,
  });

  assert.equal(result, true, 'must proceed after grace window');
  const killed = kills(tmuxStub).map((c) => c.args[2]);
  assert.deepEqual(killed.sort(), [`${TICKET}-listen`, `${TICKET}-work`], 'kills -work + -listen');
  assert.equal(readTask(manifestPath, TICKET).attempts, 2, 'attempts increments to 2');
  const deadEnd = alerts(alertFile).filter((a) => a.kind === 'dead-end');
  assert.equal(deadEnd.length, 1, 'one dead-end (kill) alert emitted');
  assert.equal(deadEnd[0].attempts, 2);
});

test('first-ever call (no marker): sends probe, attempts STAY 0, no kill — regression guard', () => {
  const { stateDir, sessionDir, alertFile } = setup();
  const manifestPath = seedManifest(sessionDir, TICKET);
  const { actions, tmuxStub } = freshEnv({ stateDir, alertFile, sessionDir });

  const result = actions.freeDeadEndSlot({
    session: `${TICKET}-work`,
    ticket: TICKET,
    kind: 'question',
    repeatCount: 5,
  });

  assert.equal(result, true);
  assert.equal(kills(tmuxStub).length, 0, 'first call must NOT kill');
  // Probe is sent because !marker.diagnosed (first dead-end of this lifecycle),
  // NOT because attempts===1. A probe is not a strike, so attempts stays 0.
  const probes = tmuxStub.filter(
    (c) =>
      c.args[0] === 'send-keys' &&
      c.args.some((a) => typeof a === 'string' && a.includes('MAESTRO DIAGNOSTIC'))
  );
  assert.equal(probes.length, 1, 'diagnostic probe sent on first call');
  assert.equal(readTask(manifestPath, TICKET).attempts || 0, 0, 'probe must NOT bump attempts');
  const probeAlerts = alerts(alertFile).filter((a) => a.kind === 'dead-end-probe');
  assert.equal(probeAlerts.length, 1, 'dead-end-probe alert emitted');
});

test('ticket not in any manifest: bails at top — no probe, no kill', () => {
  const { stateDir, sessionDir, alertFile } = setup();
  // Intentionally do NOT seed a manifest, so getTaskAttempts returns null and
  // the untracked guard at the top of freeDeadEndSlot bails before the probe.
  const { actions, tmuxStub } = freshEnv({ stateDir, alertFile, sessionDir });

  const result = actions.freeDeadEndSlot({
    session: `${TICKET}-work`,
    ticket: TICKET,
    kind: 'question',
    repeatCount: 5,
  });

  assert.equal(result, false, 'untracked ticket must bail');
  assert.equal(kills(tmuxStub).length, 0, 'no kill for an untracked ticket');
  const probes = tmuxStub.filter(
    (c) =>
      c.args[0] === 'send-keys' &&
      c.args.some((a) => typeof a === 'string' && a.includes('MAESTRO DIAGNOSTIC'))
  );
  assert.equal(probes.length, 0, 'no diagnostic probe for an untracked ticket');
  const ended = alerts(alertFile).filter(
    (a) => a.kind === 'dead-end' || a.kind === 'dead-end-probe'
  );
  assert.equal(ended.length, 0, 'no dead-end/probe alert for an untracked ticket');
});

test('AUTO_FREE_DEAD_END=0 disables freeDeadEndSlot entirely', () => {
  const { stateDir, sessionDir, alertFile } = setup();
  seedManifest(sessionDir, TICKET);
  const { actions, tmuxStub } = freshEnv({
    stateDir,
    alertFile,
    sessionDir,
    env: { AUTO_FREE_DEAD_END: '0' },
  });

  const result = actions.freeDeadEndSlot({
    session: `${TICKET}-work`,
    ticket: TICKET,
    kind: 'question',
    repeatCount: 5,
  });

  assert.equal(result, false);
  assert.equal(tmuxStub.length, 0, 'no tmux activity when disabled');
  assert.equal(fs.existsSync(alertFile), false, 'no alert when disabled');
});

test('manifest.getTaskAttempts: number when tracked, null when untracked', () => {
  const { stateDir, sessionDir, alertFile } = setup();
  seedManifest(sessionDir, TICKET, { attempts: 2 });
  const { actions } = freshEnv({ stateDir, alertFile, sessionDir });
  void actions; // ensure module cache primed under this env
  const manifest = require(path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'manifest'));
  assert.equal(manifest.getTaskAttempts(TICKET), 2, 'tracked → attempts number');
  assert.equal(manifest.getTaskAttempts('GH-999'), null, 'untracked → null');

  // A tracked task with no attempts field defaults to 0 (not null).
  seedManifest(sessionDir, 'GH-78');
  assert.equal(manifest.getTaskAttempts('GH-78'), 0, 'tracked, no field → 0');
});

// Drive one full lifecycle: fresh probe (no strike) → grace elapses → kill
// (one strike). `state.clear(ticket,'dead-end')` afterwards emulates the
// per-lifecycle marker wipe that re-bootstrap performs, WITHOUT touching the
// cross-lifecycle manifest attempts.
function driveLifecycle({ actions, state }, ticket) {
  // Probe: first dead-end of this lifecycle (no marker yet).
  actions.freeDeadEndSlot({ session: `${ticket}-work`, ticket, kind: 'question', repeatCount: 5 });
  // Push diagnosedAt past the grace window so the next call is the kill.
  const marker = state.read(ticket, 'dead-end');
  state.write(ticket, 'dead-end', {
    ...marker,
    diagnosedAt: state.now() - (GRACE_MIN * 60 + 60),
  });
  // Kill: grace elapsed → strike + rotate.
  actions.freeDeadEndSlot({ session: `${ticket}-work`, ticket, kind: 'question', repeatCount: 6 });
  // Emulate re-bootstrap: clear ONLY the per-lifecycle marker (attempts intact).
  state.clear(ticket, 'dead-end');
}

test('cross-lifecycle accumulation: third lifecycle kill reaches blocked (attempts===3)', () => {
  const { stateDir, sessionDir, alertFile } = setup();
  const manifestPath = seedManifest(sessionDir, TICKET);
  const { actions, state } = freshEnv({ stateDir, alertFile, sessionDir });

  driveLifecycle({ actions, state }, TICKET);
  assert.equal(readTask(manifestPath, TICKET).attempts, 1, 'lifecycle 1 kill → 1 strike');
  driveLifecycle({ actions, state }, TICKET);
  assert.equal(readTask(manifestPath, TICKET).attempts, 2, 'lifecycle 2 kill → 2 strikes');
  driveLifecycle({ actions, state }, TICKET);

  const task = readTask(manifestPath, TICKET);
  assert.equal(task.attempts, 3, 'lifecycle 3 kill → 3 strikes (cross-lifecycle)');
  assert.equal(task.status, 'blocked', 'blocked tier is reachable at the 3rd strike');

  const blocked = alerts(alertFile)
    .filter((a) => a.kind === 'dead-end')
    .filter((a) => a.exhausted === true);
  assert.equal(blocked.length, 1, 'exactly one exhausted (blocked) dead-end alert');
});

test('phase-advance reset restores a fresh budget: next kill is pending, not blocked', () => {
  const { stateDir, sessionDir, alertFile } = setup();
  const manifestPath = seedManifest(sessionDir, TICKET);
  const { actions, state } = freshEnv({ stateDir, alertFile, sessionDir });
  const manifest = require(path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'manifest'));

  driveLifecycle({ actions, state }, TICKET);
  driveLifecycle({ actions, state }, TICKET);
  assert.equal(readTask(manifestPath, TICKET).attempts, 2, 'two strikes accumulated');

  // Real progress (phase advance) resets the cross-lifecycle strike count.
  manifest.resetTaskAttempts(TICKET);
  assert.equal(readTask(manifestPath, TICKET).attempts, 0, 'phase advance zeroes attempts');

  // Next lifecycle's kill lands on strike 1 → pending, NOT blocked.
  driveLifecycle({ actions, state }, TICKET);
  const task = readTask(manifestPath, TICKET);
  assert.equal(task.attempts, 1, 'fresh budget: kill is strike 1 again');
  assert.notEqual(task.status, 'blocked', 'not blocked after a phase-advance reset');
});
