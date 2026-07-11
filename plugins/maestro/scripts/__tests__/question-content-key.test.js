// GH-698 A4 — content-keyed question-pending alerts. Two DIFFERENT prompts in
// the same phase used to collapse under one `session|question-pending|<phase>`
// key: the second prompt inherited the first's repeat count and throttle
// window and could be swallowed for up to PENDING_REWAKE_MAX_MIN. The alert
// identity is now a content hash of (phase, promptKind, options).
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
  return { alerts: require(LIB('alerts')), qh: require(LIB('question-handler')) };
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

const CTX = { session: 'GH-9-work', ticket: 'GH-9', phase: 'implement', skill: 'work', pane: '' };
const MENU_A = { promptKind: 'menu', options: ['❯ 1. Yes, run it', '  2. No'] };
const MENU_B = { promptKind: 'menu', options: ['❯ 1. Overwrite tasks.md', '  2. Keep'] };

test('promptAlertId: distinct prompts differ; a moved selection cursor is the SAME prompt', () => {
  const { qh } = fresh(fs.mkdtempSync(path.join(os.tmpdir(), 'qkey-')));
  const idA = qh.promptAlertId(CTX, MENU_A);
  const idB = qh.promptAlertId(CTX, MENU_B);
  assert.notEqual(idA, idB, 'different option sets are different incidents');
  const movedCursor = { promptKind: 'menu', options: ['  1. Yes, run it', '❯ 2. No'] };
  assert.equal(
    qh.promptAlertId(CTX, movedCursor),
    idA,
    'operator navigating the menu must not mint a new incident'
  );
  assert.notEqual(
    qh.promptAlertId({ ...CTX, phase: 'check' }, MENU_A),
    idA,
    'phase still scopes the identity (same prompt text in a later phase is a new incident)'
  );
});

test('alertKey: alertId refines the third segment; consumers prefix-match unaffected', () => {
  const { alerts } = fresh(fs.mkdtempSync(path.join(os.tmpdir(), 'qkey-')));
  const base = { session: 'GH-9-work', kind: 'question-pending', phase: 'implement' };
  assert.equal(alerts.alertKey(base), 'GH-9-work|question-pending|implement', 'legacy fallback');
  assert.equal(
    alerts.alertKey({ ...base, alertId: 'abc123' }),
    'GH-9-work|question-pending|abc123',
    'alertId wins over phase'
  );
  assert.ok(
    alerts.alertKey({ ...base, alertId: 'abc123' }).startsWith('GH-9-work|question-pending|'),
    'resolve()/cleanup prefix-matching still reaches every variant'
  );
});

test('two different prompts in the same phase each wake as fresh incidents (the A4 trap)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qkey-'));
  const { alerts, qh } = fresh(dir);
  const mkPayload = (qHit) => qh.buildQuestionAlertPayload({ ctx: CTX, qHit, mins: 5 });

  const s1 = captureStderr(() => alerts.alert(mkPayload(MENU_A)));
  assert.ok(s1.length > 0, 'prompt A first emission wakes');
  const s2 = captureStderr(() => alerts.alert(mkPayload(MENU_A)));
  assert.equal(s2, '', 'prompt A repeat is inside the blocking throttle window');
  const s3 = captureStderr(() => alerts.alert(mkPayload(MENU_B)));
  assert.ok(
    s3.length > 0,
    'prompt B is a FRESH incident — it must not inherit prompt A throttle state'
  );
  const records = fs
    .readFileSync(path.join(dir, 'alerts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(records[2].repeatCount, 1, 'prompt B starts its own repeat series at 1');

  // resolve() retires ALL content variants of the pair in one call.
  assert.equal(alerts.resolve('GH-9-work', 'question-pending', 'answered'), true);
  const counts = JSON.parse(fs.readFileSync(path.join(dir, '_alert-counts.json'), 'utf8'));
  assert.ok(
    !Object.keys(counts).some((k) => k.startsWith('GH-9-work|question-pending|')),
    'prefix purge reaches every content-hashed variant'
  );
});

test('promptAlertId: promptLine discriminates permission prompts with identical boilerplate options', () => {
  const { qh } = fresh(fs.mkdtempSync(path.join(os.tmpdir(), 'qkey-')));
  const OPTS = ['❯ 1. Yes', '  2. Yes, allow all edits during this session', '  3. No'];
  const editA = {
    promptKind: 'permission',
    options: OPTS,
    promptLine: 'Do you want to make this edit to alerts.js?',
  };
  const editB = {
    promptKind: 'permission',
    options: OPTS,
    promptLine: 'Do you want to make this edit to state.js?',
  };
  assert.notEqual(
    qh.promptAlertId(CTX, editA),
    qh.promptAlertId(CTX, editB),
    'same option boilerplate, different prompt line → different incidents'
  );
});

test('question.detect: options come only from the pane tail; permission promptLine is surfaced', () => {
  fresh(fs.mkdtempSync(path.join(os.tmpdir(), 'qkey-')));
  const question = require(LIB(path.join('detectors', 'question.js')));

  // Numbered prose in scrollback (a tool's output) above a real menu at the
  // bottom: the prose must not reach the options payload (it would flap the
  // A4 hash and pollute the operator-facing options).
  const scrollbackProse = Array.from(
    { length: 40 },
    (_, i) => `  ${i + 1}. step ${i + 1} of the plan`
  );
  const menu = [
    'Pick an option:',
    '❯ 1. Yes, run it',
    '  2. No',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ];
  const hit = question.detect({ pane: [...scrollbackProse, ...menu].join('\n') });
  assert.equal(hit.hit, true);
  assert.deepEqual(
    hit.options.filter((o) => /step \d+ of the plan/.test(o)),
    [],
    'scrollback prose is excluded from options'
  );
  assert.ok(
    hit.options.some((o) => o.includes('Yes, run it')),
    'the real menu options survive'
  );

  const perm = question.detect({
    pane: 'Permission rule Bash(rm:*) requires confirmation\n❯ 1. Yes\n  2. No\n',
  });
  assert.equal(perm.promptKind, 'permission');
  assert.equal(perm.promptLine, 'Permission rule Bash(rm:*) requires confirmation');
});

test('handleQuestion: a changed prompt bypasses the re-nudge cooldown; the same prompt does not', () => {
  fresh(fs.mkdtempSync(path.join(os.tmpdir(), 'qkey-')));
  const qh = require(LIB('question-handler'));

  // In-memory state + alert-capturing actions double (handleQuestion takes both injected).
  const store = new Map();
  const state = {
    read: (t, k) => store.get(`${t}.${k}`) || null,
    write: (t, k, v) => store.set(`${t}.${k}`, v),
    clear: (t, k) => store.delete(`${t}.${k}`),
    now: () => Math.floor(Date.now() / 1000),
    minutesSince: (secs) => Math.floor((Math.floor(Date.now() / 1000) - secs) / 60),
  };
  const emitted = [];
  const actions = {
    alert: (p) => {
      emitted.push(p);
      return { count: emitted.length };
    },
  };
  const drive = (qHit) =>
    qh.handleQuestion({
      ctx: CTX,
      qHit,
      state,
      actions,
      qWaitMin: 0,
      maybeEscalateToDeadEnd: () => {},
    });

  drive(MENU_A); // arms the marker, no alert yet
  drive(MENU_A);
  assert.equal(emitted.length, 1, 'prompt A alerts once past qWaitMin');
  drive(MENU_A);
  assert.equal(emitted.length, 1, 'same prompt inside Q_RE_NUDGE_MIN stays quiet');
  drive(MENU_B);
  assert.equal(emitted.length, 2, 'a CHANGED prompt alerts immediately (chained-gate fix)');
  assert.notEqual(emitted[0].alertId, emitted[1].alertId, 'payloads carry distinct alertIds');
  drive(MENU_B);
  assert.equal(emitted.length, 2, 'the new prompt then honors the cooldown itself');
});
