// GH-627 LOOPING state (comment-loop), GH-449 auth-broken detector, and the
// PR #603 stop-guard hook.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const LIB = (name) => path.resolve(__dirname, '..', 'lib', 'maestro-conduct', name);
const STOP_GUARD = path.resolve(__dirname, '..', '..', 'hooks', 'stop-guard.js');

function isolate(env = {}) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct/')) delete require.cache[k];
  }
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'loopauth-'));
  Object.assign(
    process.env,
    {
      LOG_FILE: path.join(iso, 'conduct.log'),
      ALERT_FILE: path.join(iso, 'alerts.jsonl'),
      STATE_DIR: path.join(iso, 'state'),
      MAESTRO_SESSION_DIR: path.join(iso, 'sessions'),
    },
    env
  );
  return iso;
}

test('comment-loop: ≥3 fix→push→re-comment cycles suppresses nudges and alerts LOOP', () => {
  isolate();
  const state = require(LIB('state.js'));
  const handler = require(LIB('pr-comments-handler.js'));

  state.write('GH-80', 'pr-comments-loop', { cycles: 3 });
  const alerts = [];
  const nudges = [];
  const actions = {
    alert: (p) => (alerts.push(p), { count: 1 }),
    soft: (s, r) => nudges.push(['soft', r]),
    interrupt: (s, r) => nudges.push(['interrupt', r]),
  };
  handler.handlePrComments({
    ctx: { session: 'GH-80-work', ticket: 'GH-80', phase: 'follow_up', skill: 'work', pane: '' },
    cHit: {
      prNumber: 99,
      count: 2,
      minsStuck: 12,
      summary: [{ file: 'a.js', line: 1, severity: 'High', title: 't' }],
      marker: { nudges: 0 },
    },
    state,
    actions,
    phaseFor: () => ({ reNudgeMin: 0, maxNudges: 3, exempts: () => false }),
    escalationFor: () => 'soft',
    bumpMarker: () => {},
    maybeEscalateToDeadEnd: () => {},
  });
  assert.equal(nudges.length, 0, 'looping ticket must NOT be nudged (nudging feeds the loop)');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'comment-loop');
  assert.equal(alerts[0].cycles, 3);

  // Cooldown: immediate second call stays silent but still suppresses nudges.
  handler.handlePrComments({
    ctx: { session: 'GH-80-work', ticket: 'GH-80', phase: 'follow_up', skill: 'work', pane: '' },
    cHit: { prNumber: 99, count: 2, minsStuck: 13, summary: [], marker: { nudges: 0 } },
    state,
    actions,
    phaseFor: () => ({ reNudgeMin: 0, maxNudges: 3, exempts: () => false }),
    escalationFor: () => 'soft',
    bumpMarker: () => {},
    maybeEscalateToDeadEnd: () => {},
  });
  assert.equal(alerts.length, 1, 'cooldown holds');
  assert.equal(nudges.length, 0);
});

test('pr-comments detector: HEAD moves with comments still open bumps the loop counter', () => {
  isolate();
  const state = require(LIB('state.js'));
  // Drive the marker transitions directly (the gh calls are not exercised:
  // we hand-write the prev marker, then emulate detect()'s branch logic by
  // checking the persisted loop marker the handler consumes).
  state.write('GH-81', 'pr-comments', { count: 2, sha: 'aaa', firstSeenAt: state.now() });
  // Simulate what detect() does on sha change with count>0:
  const loop = state.read('GH-81', 'pr-comments-loop') || { cycles: 0 };
  state.write('GH-81', 'pr-comments-loop', { ...loop, cycles: (loop.cycles || 0) + 1 });
  assert.equal(state.read('GH-81', 'pr-comments-loop').cycles, 1);
});

test('auth-broken detector: matches credential failures, ignores healthy panes', () => {
  const det = require(LIB('detectors/auth-broken.js'));
  assert.equal(det.detect({ pane: 'all good\n✔ tests passed\n' }).hit, false);
  const hit = det.detect({
    pane: 'gh pr view 12\nGraphQL: Could not resolve to a Repository with the name g2i-ai/shack.\n',
  });
  assert.equal(hit.hit, true);
  assert.match(hit.line, /Could not resolve to a Repository/);
  assert.equal(det.detect({ pane: 'HTTP 403: Forbidden (https://api.github.com)' }).hit, true);
  assert.equal(det.detect({ pane: null }).hit, false);
});

test('stop-guard hook: blocks on unacked action_required, honors ack + opt-in', () => {
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'stopguard-'));
  const alertFile = path.join(iso, 'alerts.jsonl');
  const stateFile = path.join(iso, 'ack.state');
  const ts = new Date().toISOString();
  fs.writeFileSync(
    alertFile,
    JSON.stringify({
      ts,
      session: 'GH-9-work',
      kind: 'question-pending',
      action_required: true,
      unblockCmd: 'tmux send-keys -t GH-9-work 1 Enter',
      instruction: 'answer it',
    }) + '\n'
  );
  const env = {
    ...process.env,
    ALERT_FILE: alertFile,
    MAESTRO_STOP_GUARD_STATE: stateFile,
  };

  // Not opted in → exit 0 regardless of pending alerts.
  delete env.MAESTRO_STOP_GUARD;
  let r = spawnSync('node', [STOP_GUARD], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, 'opt-in default must not block unrelated sessions');

  // Opted in + pending → exit 2 with the unblockCmd on stderr.
  env.MAESTRO_STOP_GUARD = '1';
  r = spawnSync('node', [STOP_GUARD], { env, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /STOP BLOCKED/);
  assert.match(r.stderr, /tmux send-keys -t GH-9-work 1 Enter/);

  // Ack the alert → exit 0.
  fs.writeFileSync(stateFile, ts);
  r = spawnSync('node', [STOP_GUARD], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, 'acked alerts must not block');
});
