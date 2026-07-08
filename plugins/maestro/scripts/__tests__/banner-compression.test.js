// GH-680 Task 2 — PENDING DECISIONS banner compression.
//
// The active-session-reminder hook re-surfaces actionable alerts on every user
// prompt (the PR #603 re-fire guarantee). To cut conductor token burn, an alert
// whose full body was already shown once *this session* should collapse to a
// `[REPEAT n] <id>: <first 80 chars>` one-liner on subsequent prompts — while
// still re-appearing every prompt until it ages out (never dropped).
//
// The hook is fail-open and reads its inputs from the filesystem, so each
// "prompt" is a fresh subprocess; the session-scoped shown-marker persists
// across runs under STATE_DIR (namespace.stateDir()).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'active-session-reminder.js');

// A single actionable alert, long enough that the first-80-chars slice is a
// strict prefix and the tail sentinel proves the body was compressed away.
const SESSION_ID = 'GH-777-work';
const ALERT_TAIL = 'ZZ_UNIQUE_TAIL_SENTINEL_9137';
const INSTRUCTION =
  'Decide whether to restart the wedged GH-777 agent or abandon the ticket now, the loop ' +
  ALERT_TAIL;
const FIRST_80 = INSTRUCTION.slice(0, 80);

/**
 * Build an isolated fixture root: a session manifest (so the reminder block
 * renders at all) plus an alert file carrying one in-window actionable alert.
 * STATE_DIR is where the session shown-marker will be written.
 */
function makeFixture(alert) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banner-compress-'));
  const sessionDir = path.join(root, 'sessions');
  const stateDir = path.join(root, 'state');
  const alertFile = path.join(root, 'alerts.jsonl');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'topic.json'),
    JSON.stringify({
      topic: 'topic',
      slots: 1,
      createdAt: new Date().toISOString(),
      tasks: [{ id: 'GH-1', priority: 1, deps: [], status: 'in_progress' }],
    })
  );
  fs.writeFileSync(alertFile, JSON.stringify(alert) + '\n');
  return { root, sessionDir, stateDir, alertFile };
}

function defaultAlert() {
  return {
    kind: 'wedged',
    session: SESSION_ID,
    ticket: 'GH-777',
    ts: new Date().toISOString(),
    instruction: INSTRUCTION,
  };
}

/** Run the hook once as a fresh subprocess (one simulated user prompt). */
function runHook(fx, sessionId = 'sess-abc') {
  const res = spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MAESTRO_SESSION_DIR: fx.sessionDir,
      STATE_DIR: fx.stateDir,
      ALERT_FILE: fx.alertFile,
      CLAUDE_CODE_SESSION_ID: sessionId,
      MAESTRO_NS: '',
    },
    timeout: 15000,
  });
  return { stdout: res.stdout || '', status: res.status };
}

function repeatNumber(line) {
  const m = /\[REPEAT (\d+)\]/.exec(line);
  return m ? Number(m[1]) : null;
}

test('first surface renders the full instruction and records the shown-marker', () => {
  const fx = makeFixture(defaultAlert());

  const { stdout } = runHook(fx);

  assert.match(stdout, /PENDING DECISIONS/, 'reminder block should render');
  assert.ok(
    stdout.includes(INSTRUCTION) || stdout.includes(ALERT_TAIL),
    'first surface shows the full instruction body including its tail'
  );
  assert.doesNotMatch(stdout, /\[REPEAT/, 'first surface is not a compressed repeat');

  const marker = path.join(fx.stateDir, '_banner-shown-sess-abc.json');
  assert.ok(fs.existsSync(marker), 'session shown-marker file is written on first surface');
  const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(typeof parsed, 'object');
});

test('subsequent same-session surfaces compress to a [REPEAT n] one-liner and keep re-firing', () => {
  const fx = makeFixture(defaultAlert());

  // Run 1: full body (also writes the shown-marker).
  const first = runHook(fx);
  assert.doesNotMatch(first.stdout, /\[REPEAT/);

  // Run 2: same session, same alert → compressed one-liner.
  const second = runHook(fx);
  const secondLine = second.stdout.split('\n').find((l) => /\[REPEAT/.test(l));
  assert.ok(secondLine, 'second surface renders a [REPEAT n] line');
  assert.ok(secondLine.includes(SESSION_ID), 'compressed line includes the alert id');
  assert.ok(secondLine.includes(FIRST_80), 'compressed line includes the first 80 chars');
  assert.ok(
    !secondLine.includes(ALERT_TAIL),
    'compressed line drops the body past the first 80 chars'
  );

  // Run 3: re-fire preserved — still emitted, and n increments.
  const third = runHook(fx);
  const thirdLine = third.stdout.split('\n').find((l) => /\[REPEAT/.test(l));
  assert.ok(thirdLine, 'alert re-appears on the third prompt (PR #603 guarantee)');
  assert.ok(thirdLine.includes(SESSION_ID), 're-fired compressed line still carries the id');
  assert.ok(
    repeatNumber(thirdLine) > repeatNumber(secondLine),
    'the [REPEAT n] counter increments on each successive surface'
  );
});

test('a new occurrence of the same kind (new alert.ts) surfaces in full again', () => {
  const fx = makeFixture(defaultAlert());

  runHook(fx); // first surface — records fingerprint for the original ts
  const compressed = runHook(fx);
  assert.match(compressed.stdout, /\[REPEAT/, 'original ts compresses on repeat');

  // A fresh alert of the same kind but a newer ts → different fingerprint.
  const newer = defaultAlert();
  newer.ts = new Date(Date.now() + 1000).toISOString();
  fs.writeFileSync(fx.alertFile, JSON.stringify(newer) + '\n');

  const resurfaced = runHook(fx);
  assert.doesNotMatch(
    resurfaced.stdout,
    /\[REPEAT/,
    'a new alert.ts is a new occurrence and shows the full body again'
  );
  assert.ok(
    resurfaced.stdout.includes(ALERT_TAIL),
    'the newer occurrence renders its full instruction'
  );
});
